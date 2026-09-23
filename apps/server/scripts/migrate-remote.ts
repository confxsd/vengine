/**
 * One-time migration: push the local `~/.vengine` data (projects, library,
 * referenced images) into a vengine API — by default the deployed worker, making
 * D1+R2 the single source of truth that both the site and local dev (via the vite
 * proxy) share.
 *
 * Last-write-wins by `updatedAt`: a remote record is only overwritten when the
 * local one is newer or the remote one doesn't exist. Assets are content-addressed,
 * so existing images are skipped and re-runs are free.
 *
 *   pnpm --filter @vengine/server migrate:remote
 *   SYNC_REMOTE_URL=http://localhost:5174 pnpm --filter @vengine/server migrate:remote
 */
import { AssetStore, LibraryStore, ProjectStore } from "@vengine/storage";
import type { ComicProject, Library } from "@vengine/shared";
import { ensureAssets, getJson, login, putJson, REMOTE_URL } from "./remote-client.js";

/** Every asset hash a set of projects + the library reference. */
function collectHashes(projects: ComicProject[], lib: Library): string[] {
  const hashes = new Set<string>();
  const add = (h: string | undefined) => h && hashes.add(h);
  for (const p of projects) {
    p.library.forEach((a) => add(a.hash));
    p.style.anchors.forEach((a) => add(a.hash));
    add(p.style.anchorHash);
    p.cast.forEach((c) => c.refHashes.forEach(add));
    p.frames.forEach((f) => {
      f.refHashes.forEach(add);
      add(f.resultHash);
      f.variants.forEach((v) => add(v.hash));
    });
  }
  for (const c of lib.characters) {
    c.refHashes.forEach(add);
    c.studies.forEach((st) => {
      add(st.resultHash);
      st.variants.forEach((v) => add(v.hash));
    });
  }
  lib.styles.forEach((st) => st.anchors.forEach((a) => add(a.hash)));
  lib.scenes.forEach((sc) => add(sc.sourceHash));
  return [...hashes];
}

async function main() {
  console.log(`Migrating local data → ${REMOTE_URL}`);
  await login();

  const assets = new AssetStore();
  const projects = new ProjectStore();
  const library = new LibraryStore();

  const localList = await projects.list();
  const fullProjects: ComicProject[] = [];
  for (const s of localList) {
    try {
      fullProjects.push(await projects.get(s.id));
    } catch {
      console.warn(`  ⚠ could not read project ${s.id} — skipping`);
    }
  }
  const lib = await library.get();
  console.log(`  local: ${fullProjects.length} projects, ${lib.characters.length} characters, ${lib.styles.length} styles, ${lib.series.length} series`);

  // 1. Assets first, so nothing renders broken even mid-migration.
  const uploaded = await ensureAssets(collectHashes(fullProjects, lib), assets, "image");
  console.log(`  ✓ assets: ${uploaded} uploaded (rest already present)`);

  // 2. Projects — LWW by updatedAt.
  type RemoteSummary = { id: string; updatedAt: string };
  const remoteProjects = await getJson<RemoteSummary[]>("/api/comics").catch(() => [] as RemoteSummary[]);
  const remoteById = new Map(remoteProjects.map((p) => [p.id, p.updatedAt]));
  let pushed = 0;
  for (const p of fullProjects) {
    const remoteAt = remoteById.get(p.id);
    if (remoteAt && remoteAt >= p.updatedAt) continue;
    await putJson(`/api/comics/${p.id}`, p);
    pushed += 1;
    console.log(`  ✓ project “${p.name}” (${p.id})`);
  }
  console.log(`  ✓ projects: ${pushed} pushed, ${fullProjects.length - pushed} already current`);

  // 3. Library entities — LWW by updatedAt per record.
  const remoteLib = await getJson<Library>("/api/library");
  const newer = <T extends { id: string; updatedAt?: string }>(local: T, remote: T | undefined) =>
    !remote || (local.updatedAt ?? "") > (remote.updatedAt ?? "");

  let chars = 0;
  for (const c of lib.characters) {
    if (newer(c, remoteLib.characters.find((r) => r.id === c.id))) {
      await putJson("/api/library/characters", c);
      chars += 1;
    }
  }
  let styles = 0;
  for (const st of lib.styles) {
    if (newer(st, remoteLib.styles.find((r) => r.id === st.id))) {
      await putJson("/api/library/styles", st);
      styles += 1;
    }
  }
  let series = 0;
  for (const s of lib.series) {
    if (newer(s, remoteLib.series.find((r) => r.id === s.id))) {
      await putJson("/api/library/series", s);
      series += 1;
    }
  }
  let scenes = 0;
  for (const sc of lib.scenes) {
    if (newer(sc, remoteLib.scenes.find((r) => r.id === sc.id))) {
      await putJson(`/api/scenes/${sc.id}`, sc);
      scenes += 1;
    }
  }
  console.log(
    `  ✓ library: ${chars} characters, ${styles} styles, ${series} series, ${scenes} scenes pushed`,
  );
  console.log("\nDone — the remote store now mirrors local data. Re-runs only push what changed.");
}

main().catch((err) => {
  console.error("migrate-remote failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
