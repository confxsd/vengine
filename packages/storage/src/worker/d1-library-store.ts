import {
  LibrarySchema,
  emptyLibrary,
  mergeStudies,
  unionVariants,
  type CharacterStudy,
  type Library,
  type LibraryCharacter,
  type StylePack,
  type TrainedLora,
  type SceneReference,
  type Series,
} from "@vengine/shared";
import type { D1Like } from "./bindings.js";
import type { LibraryStoreLike } from "../types.js";

const KEY = "main";
/** Max attempts for an optimistic read-modify-write before giving up. */
const MAX_RETRIES = 5;

interface LibraryRow {
  json: string;
  version: number;
}

/**
 * D1-backed cross-project library: a single JSON document row. The update
 * primitive re-reads inside an optimistic version loop, so a training
 * write-back and a user edit racing from different isolates retry instead of
 * clobbering — the D1 equivalent of the file store's in-process mutex.
 */
export class D1LibraryStore implements LibraryStoreLike {
  constructor(private readonly db: D1Like) {}

  async get(): Promise<Library> {
    const row = await this.db
      .prepare("SELECT json FROM library WHERE key = ?")
      .bind(KEY)
      .first<LibraryRow>();
    if (!row) return emptyLibrary();
    return LibrarySchema.parse(JSON.parse(row.json));
  }

  /** Optimistic read-modify-write of the whole document. */
  private async update(mutate: (lib: Library) => Library): Promise<Library> {
    for (let attempt = 0; ; attempt++) {
      const row = await this.db
        .prepare("SELECT json, version FROM library WHERE key = ?")
        .bind(KEY)
        .first<LibraryRow>();
      const current = row ? LibrarySchema.parse(JSON.parse(row.json)) : emptyLibrary();
      const next = LibrarySchema.parse(mutate(current));
      if (next === current) return next;
      const json = JSON.stringify(next);
      const res = row
        ? await this.db
            .prepare("UPDATE library SET json = ?, version = version + 1 WHERE key = ? AND version = ?")
            .bind(json, KEY, row.version)
            .run()
        : await this.db
            .prepare("INSERT INTO library (key, json, version) VALUES (?, ?, 1)")
            .bind(KEY, json)
            .run();
      if (res.meta.changes > 0) return next;
      if (attempt >= MAX_RETRIES) throw new Error("library: concurrent write conflict");
    }
  }

  // --- Characters ---------------------------------------------------------

  async upsertCharacter(c: LibraryCharacter): Promise<LibraryCharacter> {
    const now = new Date().toISOString();
    let saved: LibraryCharacter = c;
    await this.update((lib) => {
      const i = lib.characters.findIndex((x) => x.id === c.id);
      const existing = i >= 0 ? lib.characters[i]! : undefined;
      saved = {
        ...c,
        studies: mergeStudies(existing?.studies ?? [], c.studies ?? []),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const characters = existing
        ? lib.characters.map((x, j) => (j === i ? saved : x))
        : [...lib.characters, saved];
      return { ...lib, characters };
    });
    return saved;
  }

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

  async appendCharacterRefs(id: string, hashes: string[]): Promise<LibraryCharacter | undefined> {
    let result: LibraryCharacter | undefined;
    await this.update((lib) => {
      const i = lib.characters.findIndex((c) => c.id === id);
      if (i < 0) return lib;
      const cur = lib.characters[i]!;
      const seen = new Set(cur.refHashes);
      const refHashes = [...cur.refHashes];
      for (const h of hashes) {
        if (!seen.has(h)) {
          seen.add(h);
          refHashes.push(h);
        }
      }
      result = { ...cur, refHashes, updatedAt: new Date().toISOString() };
      return { ...lib, characters: lib.characters.map((c, j) => (j === i ? result! : c)) };
    });
    return result;
  }

  async removeCharacter(id: string): Promise<void> {
    await this.update((lib) => ({ ...lib, characters: lib.characters.filter((c) => c.id !== id) }));
  }

  // --- Character studies ---------------------------------------------------

  async updateStudy(
    characterId: string,
    studyId: string,
    mutate: (study: CharacterStudy) => CharacterStudy,
  ): Promise<LibraryCharacter | undefined> {
    let result: LibraryCharacter | undefined;
    const now = new Date().toISOString();
    await this.update((lib) => {
      const i = lib.characters.findIndex((c) => c.id === characterId);
      const study = i >= 0 ? lib.characters[i]!.studies.find((s) => s.id === studyId) : undefined;
      if (i < 0 || !study) return lib;
      const next = { ...mutate(study), updatedAt: now };
      result = {
        ...lib.characters[i]!,
        studies: lib.characters[i]!.studies.map((s) => (s.id === studyId ? next : s)),
        updatedAt: now,
      };
      return { ...lib, characters: lib.characters.map((c, j) => (j === i ? result! : c)) };
    });
    return result;
  }

  async upsertStudy(
    characterId: string,
    study: CharacterStudy,
  ): Promise<LibraryCharacter | undefined> {
    let result: LibraryCharacter | undefined;
    const now = new Date().toISOString();
    await this.update((lib) => {
      const i = lib.characters.findIndex((c) => c.id === characterId);
      if (i < 0) return lib;
      const cur = lib.characters[i]!;
      const stamped = { ...study, createdAt: study.createdAt ?? now, updatedAt: now };
      result = { ...cur, studies: mergeStudies(cur.studies, [stamped]), updatedAt: now };
      return { ...lib, characters: lib.characters.map((c, j) => (j === i ? result! : c)) };
    });
    return result;
  }

  async appendStudyVariants(
    characterId: string,
    studyId: string,
    variants: { hash: string; seed: number }[],
  ): Promise<LibraryCharacter | undefined> {
    if (variants.length === 0) return this.updateStudy(characterId, studyId, (s) => s);
    return this.updateStudy(characterId, studyId, (s) => ({
      ...s,
      variants: unionVariants(s.variants, variants),
      resultHash: variants.at(-1)!.hash,
    }));
  }

  async removeStudyVariant(
    characterId: string,
    studyId: string,
    hash: string,
  ): Promise<LibraryCharacter | undefined> {
    return this.updateStudy(characterId, studyId, (s) => {
      const variants = s.variants.filter((v) => v.hash !== hash);
      const resultHash = s.resultHash === hash ? variants.at(-1)?.hash : s.resultHash;
      return { ...s, variants, resultHash };
    });
  }

  async removeStudy(characterId: string, studyId: string): Promise<LibraryCharacter | undefined> {
    let result: LibraryCharacter | undefined;
    await this.update((lib) => {
      const i = lib.characters.findIndex((c) => c.id === characterId);
      if (i < 0) return lib;
      const cur = lib.characters[i]!;
      if (!cur.studies.some((s) => s.id === studyId)) {
        result = cur;
        return lib;
      }
      result = {
        ...cur,
        studies: cur.studies.filter((s) => s.id !== studyId),
        updatedAt: new Date().toISOString(),
      };
      return { ...lib, characters: lib.characters.map((c, j) => (j === i ? result! : c)) };
    });
    return result;
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
      characters: lib.characters.map((c) => (c.loraId === id ? { ...c, loraId: undefined } : c)),
    }));
  }

  // --- Scenes -------------------------------------------------------------

  async upsertScene(s: SceneReference): Promise<SceneReference> {
    const now = new Date().toISOString();
    let saved: SceneReference = s;
    await this.update((lib) => {
      const i = lib.scenes.findIndex((x) => x.id === s.id);
      saved = { ...s, createdAt: i >= 0 ? lib.scenes[i]!.createdAt ?? now : now, updatedAt: now };
      const scenes = i >= 0 ? lib.scenes.map((x, j) => (j === i ? saved : x)) : [...lib.scenes, saved];
      return { ...lib, scenes };
    });
    return saved;
  }

  async patchScene(id: string, patch: Partial<SceneReference>): Promise<SceneReference | undefined> {
    let result: SceneReference | undefined;
    await this.update((lib) => {
      const i = lib.scenes.findIndex((x) => x.id === id);
      if (i < 0) return lib;
      result = { ...lib.scenes[i]!, ...patch, updatedAt: new Date().toISOString() };
      return { ...lib, scenes: lib.scenes.map((x, j) => (j === i ? result! : x)) };
    });
    return result;
  }

  async removeScene(id: string): Promise<void> {
    await this.update((lib) => ({ ...lib, scenes: lib.scenes.filter((s) => s.id !== id) }));
  }

  // --- Series -------------------------------------------------------------

  async upsertSeries(s: Series): Promise<Series> {
    const now = new Date().toISOString();
    let saved: Series = s;
    await this.update((lib) => {
      const i = lib.series.findIndex((x) => x.id === s.id);
      saved = { ...s, createdAt: i >= 0 ? lib.series[i]!.createdAt ?? now : now, updatedAt: now };
      const series = i >= 0 ? lib.series.map((x, j) => (j === i ? saved : x)) : [...lib.series, saved];
      return { ...lib, series };
    });
    return saved;
  }

  async patchSeries(id: string, patch: Partial<Series>): Promise<Series | undefined> {
    let result: Series | undefined;
    await this.update((lib) => {
      const i = lib.series.findIndex((x) => x.id === id);
      if (i < 0) return lib;
      result = { ...lib.series[i]!, ...patch, updatedAt: new Date().toISOString() };
      return { ...lib, series: lib.series.map((x, j) => (j === i ? result! : x)) };
    });
    return result;
  }

  async removeSeries(id: string): Promise<void> {
    await this.update((lib) => ({ ...lib, series: lib.series.filter((s) => s.id !== id) }));
  }
}
