import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ComicProjectSchema, type ComicProject } from "@vengine/shared";

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
 * Writes are atomic (temp file + rename) and `resultHash` is treated as
 * server-authoritative: a client autosave that omits it never clobbers a hash
 * written by a run.
 */
export class ProjectStore {
  private readonly root: string;

  constructor(opts: ProjectStoreOptions = {}) {
    this.root = opts.root ?? path.join(homedir(), ".vengine", "projects");
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

  /** Atomic JSON write: write a sibling temp file, then rename over the target. */
  private async writeAtomic(filePath: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
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
    const out: ProjectSummary[] = [];
    for (const id of ids) {
      const p = await this.tryGet(id);
      if (!p) continue;
      out.push({
        id: p.id,
        name: p.name,
        frameCount: p.frames.length,
        updatedAt: p.updatedAt,
        coverHash: p.frames.find((f) => f.resultHash)?.resultHash,
      });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
   * Persist a project, stamping `updatedAt`. Merges per-frame `resultHash` from
   * the existing document so a client save that omits hashes (the common case)
   * preserves results produced by a run.
   */
  async save(incoming: ComicProject): Promise<ComicProject> {
    const project = ComicProjectSchema.parse(incoming);
    const existing = await this.tryGet(project.id);

    if (existing) {
      const priorHash = new Map(existing.frames.map((f) => [f.id, f.resultHash]));
      project.frames = project.frames.map((f) =>
        f.resultHash ? f : { ...f, resultHash: priorHash.get(f.id) },
      );
    }
    project.updatedAt = new Date().toISOString();

    await this.writeAtomic(this.projectPath(project.id), project);
    return project;
  }

  /** Copy the current project.json into snapshots/<timestamp>.json. */
  async createSnapshot(id: string): Promise<SnapshotEntry> {
    const project = await this.get(id);
    const createdAt = new Date().toISOString();
    const snapId = createdAt.replace(/[:.]/g, "-");
    await this.writeAtomic(path.join(this.snapshotsDir(id), `${snapId}.json`), project);
    return { id: snapId, createdAt };
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
