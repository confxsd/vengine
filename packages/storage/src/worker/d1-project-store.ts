import {
  ComicProjectSchema,
  unionVariants,
  type ComicFrame,
  type ComicProject,
} from "@vengine/shared";
import type { D1Like } from "./bindings.js";
import type { ProjectStoreLike, ProjectSummaryLike, SnapshotEntryLike } from "../types.js";

interface ProjectRow {
  json: string;
  version: number;
}

interface SnapshotRow {
  id: string;
  created_at: string;
}

/** Max attempts for an optimistic read-modify-write before giving up. */
const MAX_RETRIES = 5;

/**
 * D1-backed comic project store: one row per project (JSON document) plus a
 * snapshots table. Writes are optimistic (WHERE version = ?) so concurrent
 * read-modify-writes — an autosave racing a run's write-back — retry instead
 * of clobbering. Generation outputs are merge-protected exactly like the
 * file-backed store: `variants` union-merge, `resultHash` never overwritten
 * with undefined.
 */
export class D1ProjectStore implements ProjectStoreLike {
  constructor(private readonly db: D1Like) {}

  framesDir(id: string): string {
    // Worker export nodes never write to disk; the value only labels the graph.
    return `frames/${id}`;
  }

  async list(): Promise<ProjectSummaryLike[]> {
    const { results } = await this.db
      .prepare("SELECT id, json FROM projects ORDER BY updated_at DESC")
      .all<ProjectRow>();
    return results
      .map((row) => {
        const p = ComicProjectSchema.parse(JSON.parse(row.json));
        return {
          id: p.id,
          name: p.name,
          frameCount: p.frames.length,
          updatedAt: p.updatedAt,
          coverHash: coverHashOf(p.frames),
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ComicProject> {
    const row = await this.db.prepare("SELECT json FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
    if (!row) throw new Error(`project not found: ${id}`);
    return ComicProjectSchema.parse(JSON.parse(row.json));
  }

  async exists(id: string): Promise<boolean> {
    const row = await this.db.prepare("SELECT id FROM projects WHERE id = ?").bind(id).first<{ id: string }>();
    return row !== null;
  }

  async save(incoming: ComicProject): Promise<ComicProject> {
    const parsed = ComicProjectSchema.parse(incoming);
    return this.withRetry(parsed.id, (existing) => {
      const project: ComicProject = {
        ...parsed,
        frames: mergeFrames(existing?.frames, parsed.frames),
        updatedAt: new Date().toISOString(),
      };
      return project;
    });
  }

  async update(id: string, mutate: (project: ComicProject) => ComicProject): Promise<ComicProject> {
    return this.withRetry(id, (existing) => {
      if (!existing) throw new Error(`project not found: ${id}`);
      const next: ComicProject = {
        ...ComicProjectSchema.parse(mutate(existing)),
        updatedAt: new Date().toISOString(),
      };
      return next;
    });
  }

  /** Optimistic read-modify-write: re-read + retry when the row moved under us. */
  private async withRetry(
    id: string,
    build: (existing: ComicProject | undefined) => ComicProject,
  ): Promise<ComicProject> {
    for (let attempt = 0; ; attempt++) {
      const row = await this.db
        .prepare("SELECT json, version FROM projects WHERE id = ?")
        .bind(id)
        .first<ProjectRow>();
      const existing = row ? ComicProjectSchema.parse(JSON.parse(row.json)) : undefined;
      const project = build(existing);
      const json = JSON.stringify(project);
      const res = row
        ? await this.db
            .prepare("UPDATE projects SET json = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?")
            .bind(json, project.updatedAt, id, row.version)
            .run()
        : await this.db
            .prepare("INSERT INTO projects (id, json, updated_at, version) VALUES (?, ?, ?, 1)")
            .bind(id, json, project.updatedAt)
            .run();
      if (res.meta.changes > 0) return project;
      if (attempt >= MAX_RETRIES) throw new Error(`project ${id}: concurrent write conflict`);
    }
  }

  async createSnapshot(id: string): Promise<SnapshotEntryLike> {
    const project = await this.get(id);
    const createdAt = new Date().toISOString();
    const snapId = createdAt.replace(/[:.]/g, "-");
    await this.db
      .prepare("INSERT INTO snapshots (project_id, id, json, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, snapId, JSON.stringify(project), createdAt)
      .run();
    return { id: snapId, createdAt };
  }

  async listSnapshots(id: string): Promise<SnapshotEntryLike[]> {
    const { results } = await this.db
      .prepare("SELECT id, created_at FROM snapshots WHERE project_id = ? ORDER BY id DESC")
      .bind(id)
      .all<SnapshotRow>();
    return results.map((r) => ({
      id: r.id,
      createdAt: r.created_at.replace(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
        "$1-$2-$3T$4:$5:$6.$7Z",
      ),
    }));
  }
}

/** The image shown for a frame: the explicit selection, else its newest variant. */
function selectedHashOf(frame: ComicFrame): string | undefined {
  return frame.resultHash ?? frame.variants.at(-1)?.hash;
}

/** Cover thumbnail for a project = the first frame that has any image. */
function coverHashOf(frames: ComicFrame[]): string | undefined {
  for (const f of frames) {
    const h = selectedHashOf(f);
    if (h) return h;
  }
  return undefined;
}

/** Same merge policy as the file store: incoming defines membership/order;
 *  `variants` union-merge and `resultHash` survives a stale client save. */
function mergeFrames(existing: ComicFrame[] | undefined, incoming: ComicFrame[]): ComicFrame[] {
  const prior = new Map((existing ?? []).map((f) => [f.id, f]));
  return incoming.map((f) => {
    const before = prior.get(f.id);
    if (!before) return f;
    return {
      ...f,
      variants: unionVariants(before.variants, f.variants),
      resultHash: f.resultHash ?? before.resultHash,
    };
  });
}
