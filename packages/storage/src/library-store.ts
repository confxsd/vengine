import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  LibrarySchema,
  emptyLibrary,
  type Library,
  type LibraryCharacter,
  type StylePack,
  type TrainedLora,
} from "@vengine/shared";

export interface LibraryStoreOptions {
  /** Root directory; defaults to ~/.vengine/library. */
  root?: string;
}

/**
 * Local-first persistence for the **cross-project library** (characters, style
 * packs, trained LoRAs). A single JSON document at <root>/library.json, written
 * atomically (temp + rename) under one in-process mutex so concurrent upserts
 * (e.g. a training write-back landing while the user edits a character) never race
 * or half-write. Mirrors `ProjectStore`'s durability model at the scale this needs
 * — a personal tool with tens of assets, not thousands.
 *
 * Image bytes are NOT stored here: refs are content-addressed hashes resolved from
 * the global asset store, so the library is small metadata only.
 */
export class LibraryStore {
  private readonly root: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: LibraryStoreOptions = {}) {
    this.root = opts.root ?? path.join(homedir(), ".vengine", "library");
  }

  private filePath(): string {
    return path.join(this.root, "library.json");
  }

  /** Serialize every read-modify-write so two mutations can't clobber each other. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async writeAtomic(data: Library): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const tmp = `${this.filePath()}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, this.filePath());
  }

  /** The whole library; an empty (valid) library when no file exists yet. */
  async get(): Promise<Library> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath(), "utf8"));
      return LibrarySchema.parse(raw);
    } catch {
      return emptyLibrary();
    }
  }

  /** Read-modify-write the whole document under the lock. */
  private async update(mutate: (lib: Library) => Library): Promise<Library> {
    return this.withLock(async () => {
      const current = await this.get();
      const next = LibrarySchema.parse(mutate(current));
      await this.writeAtomic(next);
      return next;
    });
  }

  // --- Characters ---------------------------------------------------------

  /** Insert or replace a character by id, stamping timestamps. Returns the saved entry. */
  async upsertCharacter(c: LibraryCharacter): Promise<LibraryCharacter> {
    const now = new Date().toISOString();
    let saved: LibraryCharacter = c;
    await this.update((lib) => {
      const i = lib.characters.findIndex((x) => x.id === c.id);
      saved = { ...c, createdAt: i >= 0 ? lib.characters[i]!.createdAt ?? now : now, updatedAt: now };
      const characters = i >= 0
        ? lib.characters.map((x, j) => (j === i ? saved : x))
        : [...lib.characters, saved];
      return { ...lib, characters };
    });
    return saved;
  }

  /**
   * Read-modify-write a single field of a character *under the lock* (e.g. attach a
   * `loraId` when training starts). Unlike `upsert`, this re-reads inside the mutex
   * and merges, so a concurrent edit to a different field of the same character is
   * never clobbered by a stale full-record write. No-op (returns undefined) if gone.
   */
  async patchCharacter(
    id: string,
    patch: Partial<LibraryCharacter>,
  ): Promise<LibraryCharacter | undefined> {
    let result: LibraryCharacter | undefined;
    await this.update((lib) => {
      const i = lib.characters.findIndex((c) => c.id === id);
      if (i < 0) return lib;
      result = { ...lib.characters[i]!, ...patch, updatedAt: new Date().toISOString() };
      return { ...lib, characters: lib.characters.map((c, j) => (j === i ? result! : c)) };
    });
    return result;
  }

  /**
   * Append reference hashes to a character *under the lock*, de-duplicating against the
   * current set (re-reads inside the mutex, so two concurrent imports both land instead
   * of one clobbering the other). No-op (returns undefined) if the character is gone.
   */
  async appendCharacterRefs(id: string, hashes: string[]): Promise<LibraryCharacter | undefined> {
    let result: LibraryCharacter | undefined;
    await this.update((lib) => {
      const i = lib.characters.findIndex((c) => c.id === id);
      if (i < 0) return lib;
      const cur = lib.characters[i]!;
      const seen = new Set(cur.refHashes);
      const refHashes = [...cur.refHashes];
      for (const h of hashes) if (!seen.has(h)) {
        seen.add(h);
        refHashes.push(h);
      }
      result = { ...cur, refHashes, updatedAt: new Date().toISOString() };
      return { ...lib, characters: lib.characters.map((c, j) => (j === i ? result! : c)) };
    });
    return result;
  }

  async removeCharacter(id: string): Promise<void> {
    await this.update((lib) => ({ ...lib, characters: lib.characters.filter((c) => c.id !== id) }));
  }

  // --- Style packs --------------------------------------------------------

  async upsertStyle(s: StylePack): Promise<StylePack> {
    const now = new Date().toISOString();
    let saved: StylePack = s;
    await this.update((lib) => {
      const i = lib.styles.findIndex((x) => x.id === s.id);
      saved = { ...s, createdAt: i >= 0 ? lib.styles[i]!.createdAt ?? now : now, updatedAt: now };
      const styles = i >= 0 ? lib.styles.map((x, j) => (j === i ? saved : x)) : [...lib.styles, saved];
      return { ...lib, styles };
    });
    return saved;
  }

  async removeStyle(id: string): Promise<void> {
    await this.update((lib) => ({ ...lib, styles: lib.styles.filter((s) => s.id !== id) }));
  }

  /**
   * Insert any of `packs` whose id isn't already present (used to seed the built-in
   * style presets on boot). Existing packs are left untouched, so a user's edits to a
   * preset survive a restart. A single write; no-op when nothing is missing.
   */
  async ensureStyles(packs: StylePack[]): Promise<void> {
    await this.update((lib) => {
      const have = new Set(lib.styles.map((s) => s.id));
      const missing = packs.filter((p) => !have.has(p.id));
      return missing.length ? { ...lib, styles: [...lib.styles, ...missing] } : lib;
    });
  }

  // --- Trained LoRAs ------------------------------------------------------

  async upsertTrainedLora(t: TrainedLora): Promise<TrainedLora> {
    const now = new Date().toISOString();
    let saved: TrainedLora = t;
    await this.update((lib) => {
      const i = lib.trainedLoras.findIndex((x) => x.id === t.id);
      saved = { ...t, createdAt: i >= 0 ? lib.trainedLoras[i]!.createdAt ?? now : now, updatedAt: now };
      const trainedLoras = i >= 0
        ? lib.trainedLoras.map((x, j) => (j === i ? saved : x))
        : [...lib.trainedLoras, saved];
      return { ...lib, trainedLoras };
    });
    return saved;
  }

  /**
   * Patch a training record in place (e.g. on completion: set `loraUrl`/`status`).
   * No-op if the id is gone (the user deleted it mid-train). Returns the updated
   * record, or undefined if it no longer exists.
   */
  async patchTrainedLora(
    id: string,
    patch: Partial<TrainedLora>,
  ): Promise<TrainedLora | undefined> {
    let result: TrainedLora | undefined;
    await this.update((lib) => {
      const i = lib.trainedLoras.findIndex((x) => x.id === id);
      if (i < 0) return lib;
      result = { ...lib.trainedLoras[i]!, ...patch, updatedAt: new Date().toISOString() };
      return { ...lib, trainedLoras: lib.trainedLoras.map((x, j) => (j === i ? result! : x)) };
    });
    return result;
  }

  async removeTrainedLora(id: string): Promise<void> {
    await this.update((lib) => ({
      ...lib,
      trainedLoras: lib.trainedLoras.filter((t) => t.id !== id),
      // Detach any character pointing at the deleted LoRA so nothing dangles.
      characters: lib.characters.map((c) => (c.loraId === id ? { ...c, loraId: undefined } : c)),
    }));
  }
}
