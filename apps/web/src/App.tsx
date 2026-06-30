import { useEffect, lazy } from "react";
import { Routes, Route } from "react-router-dom";
import { useLibrary } from "./libraryStore";
import { AppShell } from "./routes/AppShell";
import { CanvasPage } from "./routes/CanvasPage";
import { ComicStudio } from "./comic/ComicStudio";

// New management pages are code-split: the Studio/Canvas core stays in the main
// bundle, while Library/Scenes/Series/Settings stream in on first visit.
const LibraryPage = lazy(() => import("./routes/LibraryPage"));
const CharacterDetailPage = lazy(() => import("./routes/CharacterDetailPage"));
const ScenesPage = lazy(() => import("./routes/ScenesPage"));
const SeriesPage = lazy(() => import("./routes/SeriesPage"));
const SettingsPage = lazy(() => import("./routes/SettingsPage"));

export default function App() {
  const initLibrary = useLibrary((s) => s.init);

  // The cross-project library loads once and lives for the app's lifetime, so its
  // slide-over and the training socket are available on every page.
  useEffect(() => {
    initLibrary();
  }, [initLibrary]);

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<ComicStudio />} />
        <Route path="canvas" element={<CanvasPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="library/characters/:id" element={<CharacterDetailPage />} />
        <Route path="scenes" element={<ScenesPage />} />
        <Route path="series" element={<SeriesPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
