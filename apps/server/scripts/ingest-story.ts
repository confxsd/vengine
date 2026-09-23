/**
 * Ingest a story file as a new episode — the CLI twin of the web composer.
 * Parses the text (universe-aware: auto-detected or explicit), wires the universe's
 * style pack + cast into a new project, links the episode into the series, and runs
 * generation for every frame.
 *
 *   pnpm --filter @vengine/server story path/to/story.txt [--series the-batman] \
 *        [--model fal/seedream-v4] [--no-generate] [--title "The Batman 4"]
 *
 * Auto-detection needs no flags: mention batman/joker/gotham… and “The Batman”
 * universe is picked up from the series' keywords + cast aliases.
 */
import { readFileSync } from "node:fs";
import { stylePackToComicStyle, type ComicCharacter, type ComicFrame, type ComicProject, type DraftParse, type Library } from "@vengine/shared";
import { getJson, login, postJson, putJson } from "./remote-client.js";

function usage(): never {
  console.error(
    "usage: pnpm --filter @vengine/server story <file.txt|-> [--series <id>] [--model <id>] [--no-generate] [--title <name>]",
  );
  process.exit(2);
}

/** Map parsed character names onto cast ids via name OR alias (mirrors the client). */
function draftToFrames(parse: DraftParse, cast: ComicCharacter[]): ComicFrame[] {
  const byName = new Map<string, string>();
  for (const c of cast) {
    for (const n of [c.name, ...c.aliases]) {
      const key = n.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, c.id);
    }
  }
  return parse.frames.map((f) => {
    const ids = [...new Set(f.characters.map((n) => byName.get(n.trim().toLowerCase())).filter((v): v is string => !!v))];
    return {
      id: crypto.randomUUID().slice(0, 8),
      prompt: f.prompt,
      variants: [],
      refHashes: [],
      ...(f.script.trim() ? { script: f.script } : {}),
      ...(ids.length ? { characterIds: ids } : {}),
    };
  });
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const file = args.shift();
  if (!file) usage();
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const seriesFlag = flag("series");
  const model = flag("model");
  const title = flag("title");
  const noGenerate = args.includes("--no-generate") || flag("generate") === "no";

  const text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  await login();

  // 1. Parse (universe-aware).
  console.log("Parsing story…");
  const parse = await postJson<DraftParse & { series: { id: string; name: string; matchedBy: string[] } | null }>(
    "/api/draft/parse",
    { text, ...(seriesFlag ? { seriesId: seriesFlag } : {}) },
  );
  const seriesId = seriesFlag ?? parse.series?.id ?? undefined;
  if (parse.series) {
    console.log(
      `  universe: “${parse.series.name}”${parse.series.matchedBy.length ? ` (matched: ${parse.series.matchedBy.slice(0, 6).join(", ")})` : ""}`,
    );
  }
  console.log(`  title: ${parse.title || "(untitled)"} · ${parse.frames.length} frames`);

  // 2. Wire the universe (style pack + cast) into a new project.
  const library = seriesId ? await getJson<Library>("/api/library") : null;
  const series = library?.series.find((s) => s.id === seriesId);
  if (seriesFlag && !series) {
    console.error(`Series “${seriesFlag}” not found.`);
    process.exit(1);
  }
  const pack = series?.defaultStyleId ? library?.styles.find((st) => st.id === series.defaultStyleId) : undefined;
  const castChars = series ? library!.characters.filter((c) => series.castIds.includes(c.id)) : [];
  const cast: ComicCharacter[] = castChars.map((c) => {
    const lora = c.loraId ? library!.trainedLoras.find((t) => t.id === c.loraId) : undefined;
    return {
      id: c.id,
      name: c.name,
      aliases: c.aliases,
      refHashes: c.refHashes,
      libraryId: c.id,
      ...(lora && lora.status === "ready" && lora.loraUrl
        ? { loraPath: lora.loraUrl, loraScale: 1, loraName: lora.name }
        : {}),
    };
  });

  const created = await postJson<ComicProject>("/api/comics", { name: title ?? parse.title ?? undefined });
  const style = pack ? stylePackToComicStyle(pack) : created.style;
  const episode: ComicProject = {
    ...created,
    ...(series ? { seriesId: series.id } : {}),
    story: parse.story || created.story,
    settings: parse.settings || created.settings,
    cast,
    library: [...cast.flatMap((c) => c.refHashes), ...(pack?.anchors ?? []).map((a) => a.hash)].reduce<
      ComicProject["library"]
    >((acc, hash) => (acc.some((a) => a.hash === hash) ? acc : [...acc, { hash, label: "" }]), created.library),
    style: model ? { ...style, model } : style,
    frames: draftToFrames(parse, cast),
  };
  await putJson(`/api/comics/${created.id}`, episode);
  console.log(`  project “${episode.name}” created (${episode.id})${model ? ` · model ${model}` : ""}`);

  // 3. Link the episode into the universe.
  if (series && !series.projectIds.includes(created.id)) {
    await putJson("/api/library/series", { ...series, projectIds: [...series.projectIds, created.id] });
    console.log(`  linked into “${series.name}”`);
  }

  if (noGenerate) {
    console.log("\nSkipped generation (--no-generate). Open the Studio and hit Run when ready.");
    return;
  }

  // 4. Generate every frame (the request resolves when the whole run settles).
  console.log(`Generating ${episode.frames.length} frame(s)…`);
  const result = await postJson<{ status: string; error?: string; generated: number; cached: number }>(
    `/api/comics/${created.id}/run`,
    { frameIds: episode.frames.map((f) => f.id) },
  );
  if (result.status === "done") {
    console.log(`  done ✓ · ${result.generated} generated, ${result.cached} cached`);
  } else {
    console.error(`  run ${result.status}${result.error ? `: ${result.error}` : ""}`);
    process.exitCode = 1;
  }
  console.log(`\nEpisode ready: ${episode.name} (${episode.frames.length} frames).`);
}

main().catch((err) => {
  console.error("story failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
