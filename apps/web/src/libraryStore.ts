import { create } from "zustand";
import { toast } from "sonner";
import { api, connectLibrary } from "./api";
import type {
  Library,
  LibraryCharacter,
  StylePack,
  TrainedLora,
  TrainerInfo,
  StartTrainingRequest,
} from "./types";

const EMPTY: Library = { characters: [], styles: [], trainedLoras: [] };
const newId = () => crypto.randomUUID().slice(0, 8);

/** Guard against a second WS / double-load on a hot-reload remount. */
let initialized = false;
/** The live socket's unsubscribe, kept at module scope so HMR can close it (below). */
let socketUnsub: (() => void) | undefined;

interface LibraryState {
  library: Library;
  trainers: TrainerInfo[];
  open: boolean;
  /** True while a higher modal (the Train dialog) is open, so the panel's Esc handler
   *  yields to it (Esc closes the modal, not the whole panel). */
  modalOpen: boolean;
  loaded: boolean;

  init: () => void;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setModalOpen: (modalOpen: boolean) => void;
  /** Refetch the authoritative library (source of truth; called on WS reconnect). */
  refetch: () => Promise<void>;

  createCharacter: (name: string) => Promise<LibraryCharacter | undefined>;
  /** Atomic, serialized field update of a character (race-safe; see `commitCharacter`). */
  patchCharacter: (id: string, patch: Partial<LibraryCharacter>) => Promise<void>;
  deleteCharacter: (id: string) => Promise<void>;
  addCharacterRef: (id: string, file: File) => Promise<void>;

  createStyle: (name: string) => Promise<void>;
  patchStylePack: (id: string, patch: Partial<StylePack>) => Promise<void>;
  deleteStyle: (id: string) => Promise<void>;

  startTraining: (req: StartTrainingRequest) => Promise<void>;
  deleteLora: (id: string) => Promise<void>;

  /** Resolve a character's trained LoRA (for status badges / attach-to-project). */
  loraById: (id?: string) => TrainedLora | undefined;
}

export const useLibrary = create<LibraryState>((set, get) => {
  // All persistence runs through one serial tail so two overlapping saves (e.g. a name
  // blur landing while an image upload commits) can't interleave and clobber each
  // other — the client mirror of the server's per-id mutex.
  let saveTail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = saveTail.then(fn, fn);
    saveTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const mergeLora = (lora: TrainedLora) =>
    set((s) => {
      const exists = s.library.trainedLoras.some((t) => t.id === lora.id);
      const trainedLoras = exists
        ? s.library.trainedLoras.map((t) => (t.id === lora.id ? lora : t))
        : [...s.library.trainedLoras, lora];
      return { library: { ...s.library, trainedLoras } };
    });

  /**
   * Apply `mutate` to a character: optimistic update *immediately* (responsive), then
   * a serialized PUT that re-reads the latest state inside the tail — so the request
   * always carries every prior optimistic change, never a stale snapshot.
   */
  const commitCharacter = (id: string, mutate: (c: LibraryCharacter) => LibraryCharacter): Promise<void> => {
    let changed = false;
    set((s) => {
      const c = s.library.characters.find((x) => x.id === id);
      if (!c) return s;
      const next = mutate(c);
      if (next === c) return s;
      changed = true;
      return { library: { ...s.library, characters: s.library.characters.map((x) => (x.id === id ? next : x)) } };
    });
    if (!changed) return Promise.resolve();
    return serialize(async () => {
      const latest = get().library.characters.find((x) => x.id === id);
      if (!latest) return;
      try {
        const saved = await api.upsertCharacter(latest);
        set((s) => ({
          library: { ...s.library, characters: s.library.characters.map((x) => (x.id === id ? saved : x)) },
        }));
      } catch (err) {
        toast.error("Couldn't save character", { description: (err as Error).message });
        void get().refetch();
      }
    });
  };

  const commitStyle = (id: string, mutate: (s: StylePack) => StylePack): Promise<void> => {
    let changed = false;
    set((s) => {
      const st = s.library.styles.find((x) => x.id === id);
      if (!st) return s;
      const next = mutate(st);
      if (next === st) return s;
      changed = true;
      return { library: { ...s.library, styles: s.library.styles.map((x) => (x.id === id ? next : x)) } };
    });
    if (!changed) return Promise.resolve();
    return serialize(async () => {
      const latest = get().library.styles.find((x) => x.id === id);
      if (!latest) return;
      try {
        const saved = await api.upsertStyle(latest);
        set((s) => ({ library: { ...s.library, styles: s.library.styles.map((x) => (x.id === id ? saved : x)) } }));
      } catch (err) {
        toast.error("Couldn't save style", { description: (err as Error).message });
        void get().refetch();
      }
    });
  };

  return {
    library: EMPTY,
    trainers: [],
    open: false,
    modalOpen: false,
    loaded: false,

    init: () => {
      if (initialized) return;
      initialized = true;
      // Connect the self-healing socket FIRST, independent of the initial fetch — a cold
      // server or a failed initial load still leaves a live, reconnecting socket.
      socketUnsub?.();
      socketUnsub = connectLibrary({
        onTraining: mergeLora,
        onReconnect: () => void get().refetch(),
      });
      void (async () => {
        try {
          const [library, trainers] = await Promise.all([api.library(), api.trainers()]);
          set({ library, trainers, loaded: true });
        } catch (err) {
          toast.error("Couldn't load the library", { description: (err as Error).message });
        }
      })();
    },

    setOpen: (open) => set({ open }),
    toggle: () => set((s) => ({ open: !s.open })),
    setModalOpen: (modalOpen) => set({ modalOpen }),

    refetch: async () => {
      try {
        set({ library: await api.library() });
      } catch {
        /* transient — the next reconnect/poll will resync */
      }
    },

    createCharacter: async (name) => {
      const draft: LibraryCharacter = {
        id: newId(),
        name: name.trim() || "New character",
        refHashes: [],
        description: "",
        palette: [],
        tags: [],
      };
      try {
        const saved = await api.upsertCharacter(draft);
        set((s) => ({ library: { ...s.library, characters: [...s.library.characters, saved] } }));
        return saved;
      } catch (err) {
        toast.error("Couldn't create character", { description: (err as Error).message });
        return undefined;
      }
    },

    patchCharacter: (id, patch) => commitCharacter(id, (c) => ({ ...c, ...patch })),

    deleteCharacter: async (id) => {
      set((s) => ({
        library: { ...s.library, characters: s.library.characters.filter((c) => c.id !== id) },
      }));
      await api.removeCharacter(id).catch(() => void get().refetch());
    },

    addCharacterRef: async (id, file) => {
      let ref;
      try {
        ref = await api.uploadAsset(file);
      } catch (err) {
        toast.error("Couldn't add reference", { description: (err as Error).message });
        return;
      }
      // Append atomically through the same serial tail so concurrent uploads don't
      // each overwrite the refs array from a stale snapshot.
      await commitCharacter(id, (c) =>
        c.refHashes.includes(ref!.hash) ? c : { ...c, refHashes: [...c.refHashes, ref!.hash] },
      );
    },

    createStyle: async (name) => {
      const draft: StylePack = {
        id: newId(),
        name: name.trim() || "New style",
        theme: "",
        negative: "",
        width: 768,
        height: 1344,
        recommendedModelId: "",
        anchors: [],
        loras: [],
        tags: [],
        builtIn: false,
      };
      try {
        const saved = await api.upsertStyle(draft);
        set((s) => ({ library: { ...s.library, styles: [...s.library.styles, saved] } }));
      } catch (err) {
        toast.error("Couldn't create style", { description: (err as Error).message });
      }
    },

    patchStylePack: (id, patch) => commitStyle(id, (s) => ({ ...s, ...patch })),

    deleteStyle: async (id) => {
      set((s) => ({ library: { ...s.library, styles: s.library.styles.filter((x) => x.id !== id) } }));
      await api.removeStyle(id).catch(() => void get().refetch());
    },

    startTraining: async (req) => {
      try {
        const record = await api.startTraining(req);
        mergeLora(record);
        // The server already linked the LoRA to the character; mirror it locally
        // (no full refetch — avoids a flash and clobbering other in-flight edits).
        if (req.characterId) {
          set((s) => ({
            library: {
              ...s.library,
              characters: s.library.characters.map((c) =>
                c.id === req.characterId ? { ...c, loraId: record.id } : c,
              ),
            },
          }));
        }
        toast.success(`Training "${record.name}" started`, {
          description: "It runs in the background — you can keep working.",
        });
      } catch (err) {
        toast.error("Couldn't start training", { description: (err as Error).message });
        throw err;
      }
    },

    deleteLora: async (id) => {
      set((s) => ({
        library: { ...s.library, trainedLoras: s.library.trainedLoras.filter((t) => t.id !== id) },
      }));
      await api.removeLora(id).catch(() => void get().refetch());
    },

    loraById: (id) => (id ? get().library.trainedLoras.find((t) => t.id === id) : undefined),
  };
});

// Close the live socket on a hot-module swap so dev reloads don't leak an
// ever-growing pile of reconnecting sockets. (Vite injects `import.meta.hot` in dev;
// typed loosely here since the app tsconfig doesn't pull in vite/client.)
const hot = (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot;
if (hot) hot.dispose(() => socketUnsub?.());
