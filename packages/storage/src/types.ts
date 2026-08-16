import type {
  Asset,
  AssetRef,
  ComicProject,
  Library,
  LibraryCharacter,
  CharacterStudy,
  StylePack,
  TrainedLora,
  SceneReference,
  Series,
} from "@vengine/shared";

/**
 * Storage-driver interfaces. The Node server implements them with local files
 * (+ sharp thumbnails); the Cloudflare Worker implements them with R2 + D1.
 * Route modules type against these so either runtime satisfies the same shape.
 */

export interface AssetStoreLike {
  put(bytes: Uint8Array, mime: string): Promise<AssetRef>;
  has(hash: string): Promise<boolean>;
  get(hash: string): Promise<Uint8Array>;
  getMeta(hash: string): Promise<Asset>;
  thumbPath(hash: string): string;
}

export interface ProjectSummaryLike {
  id: string;
  name: string;
  frameCount: number;
  updatedAt: string;
  coverHash?: string;
}

export interface SnapshotEntryLike {
  id: string;
  createdAt: string;
}

export interface ProjectStoreLike {
  list(): Promise<ProjectSummaryLike[]>;
  get(id: string): Promise<ComicProject>;
  exists(id: string): Promise<boolean>;
  save(incoming: ComicProject): Promise<ComicProject>;
  update(id: string, mutate: (project: ComicProject) => ComicProject): Promise<ComicProject>;
  createSnapshot(id: string): Promise<SnapshotEntryLike>;
  listSnapshots(id: string): Promise<SnapshotEntryLike[]>;
  framesDir(id: string): string;
}

export interface LibraryStoreLike {
  get(): Promise<Library>;
  upsertCharacter(c: LibraryCharacter): Promise<LibraryCharacter>;
  patchCharacter(id: string, patch: Partial<LibraryCharacter>): Promise<LibraryCharacter | undefined>;
  appendCharacterRefs(id: string, hashes: string[]): Promise<LibraryCharacter | undefined>;
  removeCharacter(id: string): Promise<void>;
  updateStudy(
    characterId: string,
    studyId: string,
    mutate: (study: CharacterStudy) => CharacterStudy,
  ): Promise<LibraryCharacter | undefined>;
  upsertStudy(characterId: string, study: CharacterStudy): Promise<LibraryCharacter | undefined>;
  appendStudyVariants(
    characterId: string,
    studyId: string,
    variants: { hash: string; seed: number }[],
  ): Promise<LibraryCharacter | undefined>;
  removeStudyVariant(
    characterId: string,
    studyId: string,
    hash: string,
  ): Promise<LibraryCharacter | undefined>;
  removeStudy(characterId: string, studyId: string): Promise<LibraryCharacter | undefined>;
  upsertStyle(s: StylePack): Promise<StylePack>;
  removeStyle(id: string): Promise<void>;
  ensureStyles(packs: StylePack[]): Promise<void>;
  upsertTrainedLora(t: TrainedLora): Promise<TrainedLora>;
  patchTrainedLora(id: string, patch: Partial<TrainedLora>): Promise<TrainedLora | undefined>;
  removeTrainedLora(id: string): Promise<void>;
  upsertScene(s: SceneReference): Promise<SceneReference>;
  patchScene(id: string, patch: Partial<SceneReference>): Promise<SceneReference | undefined>;
  removeScene(id: string): Promise<void>;
  upsertSeries(s: Series): Promise<Series>;
  patchSeries(id: string, patch: Partial<Series>): Promise<Series | undefined>;
  removeSeries(id: string): Promise<void>;
}
