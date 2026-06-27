import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  ComicProjectSchema,
  unionVariants,
  type ComicFrame,
  type ComicProject,
} from "@vengine/shared";

export interface ProjectStoreOptions {
  /** Root directory; defaults to ~/.vengine/projects. */
  root?: string;
}

/** Lightweight listing entry for the project switcher. */
export interface ProjectSummary {
  id: string;
  name: string;
  frameCount: number;
  updatedAt: string;
  /** First frame's result hash, for a cover thumbnail. */
  coverHash?: string;
}

export interface SnapshotEntry {
  /** Snapshot id == the filename stem (an ISO timestamp, fs-safe). */
  id: string;
  createdAt: string;
}

/**
 * Local-first persistence for comic projects. Each project is a JSON document
 * plus a frames/ dir (export target) and a snapshots/ dir of point-in-time
 * copies. Layout: <root>/<id>/{project.json, frames/, snapshots/<ts>.json}.
 *
 * Writes are atomic (unique temp file + rename) and the whole read-modify-write
 * is serialized per project id by an in-process mutex, so a debounced client
 * autosave and a run's result write-back can't interleave and lose data.
 * Generation outputs (`variants`, `resultHash`) are server-authoritative: the
 * store union-merges `variants` and never clobbers a `resultHash` with undefined,
 * so a stale client save can never drop an iteration or a generated image.
 */
export class ProjectStore {
  private readonly root: string;
  /** Per-id promise chain: serializes read-modify-write so saves never race. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(opts: ProjectStoreOptions = {}) {
    this.root = opts.root ?? path.join(homedir(), ".vengine", "projects");
  }

  /** Run `fn` after any pending operation on the same id has settled. */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive without leaking rejections to the next waiter.
    this.locks.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private dir(id: string): string {
    return path.join(this.root, id);
  }
  private projectPath(id: string): string {
    return path.join(this.dir(id), "project.json");
  }
  /** Directory the export nodes write a project's frame images to. */
  framesDir(id: string): string {
    return path.join(this.dir(id), "frames");
  }
  private snapshotsDir(id: string): string {
    return path.join(this.dir(id), "snapshots");
  }

  /** Atomic JSON write: write a unique sibling temp file, then rename over the
   *  target. A random temp name avoids two concurrent writers colliding. */
  private async writeAtomic(filePath: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, filePath);
  }

  async list(): Promise<ProjectSummary[]> {
    let ids: string[];
    try {
      ids = await fs.readdir(this.root);
    } catch {
      return []; // no projects dir yet
    }
    const projects = await Promise.all(ids.map((id) => this.tryGet(id)));
    return projects
      .filter((p): p is ComicProject => p !== undefined)
      .map((p) => ({
        id: p.id,
        name: p.name,
        frameCount: p.frames.length,
        updatedAt: p.updatedAt,
        coverHash: coverHashOf(p.frames),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async tryGet(id: string): Promise<ComicProject | undefined> {
    try {
      return await this.get(id);
    } catch {
      return undefined;
    }
  }

  async get(id: string): Promise<ComicProject> {
    const raw = JSON.parse(await fs.readFile(this.projectPath(id), "utf8"));
    return ComicProjectSchema.parse(raw);
  }

  async exists(id: string): Promise<boolean> {
    try {
      await fs.access(this.projectPath(id));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Persist a project (client save / autosave). Under the per-id lock, merges the
   * incoming document against what's on disk so generation outputs survive a stale
   * client: `variants` are union-merged per frame and `resultHash` is never
   * overwritten with undefined. Stamps `updatedAt`.
   */
  async save(incoming: ComicProject): Promise<ComicProject> {
    const parsed = ComicProjectSchema.parse(incoming);
    return this.withLock(parsed.id, async () => {
      const existing = await this.tryGet(parsed.id);
      const project: ComicProject = {
        ...parsed,
        frames: mergeFrames(existing?.frames, parsed.frames),
        updatedAt: new Date().toISOString(),
      };
      await this.writeAtomic(this.projectPath(project.id), project);
      return project;
    });
  }

  /**
   * Read-modify-write a project atomically under the per-id lock. Used by the run
   * write-back so it always edits the *latest* document (never a stale snapshot
   * captured before a long generation), preventing lost concurrent edits.
   */
  async update(
    id: string,
    mutate: (project: ComicProject) => ComicProject,
  ): Promise<ComicProject> {
    return this.withLock(id, async () => {
      const current = await this.get(id);
      const next: ComicProject = {
        ...ComicProjectSchema.parse(mutate(current)),
        updatedAt: new Date().toISOString(),
      };
      await this.writeAtomic(this.projectPath(id), next);
      return next;
    });
  }

  /** Copy the current project.json into snapshots/<timestamp>.json. */
  async createSnapshot(id: string): Promise<SnapshotEntry> {
    return this.withLock(id, async () => {
      const project = await this.get(id);
      const createdAt = new Date().toISOString();
      const snapId = createdAt.replace(/[:.]/g, "-");
      await this.writeAtomic(path.join(this.snapshotsDir(id), `${snapId}.json`), project);
      return { id: snapId, createdAt };
    });
  }

  async listSnapshots(id: string): Promise<SnapshotEntry[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.snapshotsDir(id));
    } catch {
      return [];
    }
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const snapId = f.replace(/\.json$/, "");
        // Reverse the fs-safe stamp back into an ISO instant for display.
        const iso = snapId.replace(
          /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
          "$1-$2-$3T$4:$5:$6.$7Z",
        );
        return { id: snapId, createdAt: iso };
      })
      .sort((a, b) => b.id.localeCompare(a.id));
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

/**
 * Merge incoming frames against what's on disk, by frame id. The incoming list
 * defines membership + order (so add/remove/reorder work), but per surviving
 * frame the server-authoritative generation outputs are protected: `variants`
 * are union-merged and `resultHash` is preserved when the client omits it.
 */
function mergeFrames(
  existing: ComicFrame[] | undefined,
  incoming: ComicFrame[],
): ComicFrame[] {
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
