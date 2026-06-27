import { create } from "zustand";

/** Top-level view: the comic storyboard (default) or the raw node canvas. */
export type AppMode = "storyboard" | "canvas";

export const useAppMode = create<{ mode: AppMode; setMode: (m: AppMode) => void }>((set) => ({
  mode: "storyboard",
  setMode: (mode) => set({ mode }),
}));
