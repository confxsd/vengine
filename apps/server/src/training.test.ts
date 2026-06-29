import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LibraryStore } from "@vengine/storage";
import { FalHttpError, type TrainingAdapter, type TrainingHandle, type TrainingPoll } from "@vengine/providers";
import type { TrainingProgressEvent } from "@vengine/shared";
import { TrainingService, type TrainingServiceDeps } from "./training.js";

const HASH = "a".repeat(64);

/** A scriptable fake trainer: `submit` returns a handle; each `poll` shifts the next
 *  scripted response (repeating the last). `poll` can be made to throw to model a
 *  transient network blip. */
function fakeTrainer(script: Array<TrainingPoll | "throw">, id = "fake/trainer"): TrainingAdapter {
  let i = 0;
  return {
    id,
    provider: "fake",
    displayName: "Fake Trainer",
    baseModelId: "fake/lora",
    trains: "both",
    pricePerStep: 0.01,
    estimateCost: (input) => (input.steps ?? 1000) * 0.01,
    async submit(): Promise<TrainingHandle> {
      return {
        jobId: "job-1",
        endpoint: "fake-ai/trainer",
        steps: 1000,
        statusUrl: "https://q/fake/requests/job-1/status",
        responseUrl: "https://q/fake/requests/job-1",
      };
    },
    async poll(): Promise<TrainingPoll> {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step === "throw") throw new Error("transient network blip");
      return step;
    },
    async train() {
      throw new Error("not used");
    },
  };
}

/** Minimal asset store stub: training only needs bytes + mime per hash. */
const fakeAssets = {
  getMeta: async () => ({ mime: "image/png" }),
  get: async () => Buffer.from([1, 2, 3]),
} as unknown as TrainingServiceDeps["assets"];

let root: string;
let library: LibraryStore;
let events: TrainingProgressEvent[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "vengine-training-"));
  library = new LibraryStore({ root });
  events = [];
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeService(
  trainer: TrainingAdapter,
  over: Partial<TrainingServiceDeps> = {},
): TrainingService {
  const trainers = {
    get: (id: string) => (id === trainer.id ? trainer : undefined),
    require: (id: string) => {
      if (id !== trainer.id) throw new Error(`unknown ${id}`);
      return trainer;
    },
  };
  return new TrainingService({
    library,
    assets: fakeAssets,
    trainers,
    getApiKey: () => "k",
    broadcast: (e) => events.push(e),
    pollMs: 3,
    ...over,
  });
}

/** Poll the library until `pred` holds (or time out — a failed test, not a hang). */
async function waitFor(pred: (lib: Awaited<ReturnType<LibraryStore["get"]>>) => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const lib = await library.get();
    if (pred(lib)) return lib;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 4));
  }
}

describe("TrainingService", () => {
  it("start persists a 'training' record immediately, then completes to 'ready'", async () => {
    const svc = makeService(fakeTrainer([{ status: "training" }, { status: "ready", result: { loraUrl: "https://w/lora.safetensors", costUsd: 10 } }]));
    const rec = await svc.start({ trainerId: "fake/trainer", name: "Yue", kind: "subject", refHashes: [HASH] });

    expect(rec.status).toBe("training");
    expect(rec.jobId).toBe("job-1"); // durable handle persisted
    expect(rec.jobStatusUrl).toContain("/status");
    expect(events[0]?.lora.status).toBe("training"); // broadcast on submit

    const lib = await waitFor((l) => l.trainedLoras[0]?.status === "ready");
    const ready = lib.trainedLoras[0]!;
    expect(ready.loraUrl).toBe("https://w/lora.safetensors");
    expect(ready.costUsd).toBe(10);
    expect(events.at(-1)?.lora.status).toBe("ready"); // broadcast on completion
  });

  it("attaches the trained LoRA to a character on start", async () => {
    await library.upsertCharacter({ id: "yue", name: "Yue" } as never);
    const svc = makeService(fakeTrainer([{ status: "ready", result: { loraUrl: "u", costUsd: 1 } }]));
    const rec = await svc.start({ trainerId: "fake/trainer", name: "Yue", kind: "subject", refHashes: [HASH], characterId: "yue" });
    const lib = await library.get();
    expect(lib.characters[0]!.loraId).toBe(rec.id); // linked immediately, before completion
  });

  it("records a failure when the job fails", async () => {
    const svc = makeService(fakeTrainer([{ status: "failed", error: "fal said no" }]));
    await svc.start({ trainerId: "fake/trainer", name: "X", kind: "style", refHashes: [HASH] });
    const lib = await waitFor((l) => l.trainedLoras[0]?.status === "failed");
    expect(lib.trainedLoras[0]!.error).toBe("fal said no");
  });

  it("survives a transient poll error and still completes", async () => {
    const svc = makeService(fakeTrainer(["throw", "throw", { status: "ready", result: { loraUrl: "u2", costUsd: 2 } }]));
    await svc.start({ trainerId: "fake/trainer", name: "X", kind: "subject", refHashes: [HASH] });
    const lib = await waitFor((l) => l.trainedLoras[0]?.status === "ready");
    expect(lib.trainedLoras[0]!.loraUrl).toBe("u2"); // retried past the blips
  });

  it("times out a job that never finishes", async () => {
    const svc = makeService(fakeTrainer([{ status: "training" }]), { deadlineMs: -1 });
    await svc.start({ trainerId: "fake/trainer", name: "X", kind: "subject", refHashes: [HASH] });
    const lib = await waitFor((l) => l.trainedLoras[0]?.status === "failed");
    expect(lib.trainedLoras[0]!.error).toMatch(/timed out/);
  });

  it("requires an API key", async () => {
    const svc = makeService(fakeTrainer([{ status: "training" }]), { getApiKey: () => undefined });
    await expect(
      svc.start({ trainerId: "fake/trainer", name: "X", kind: "subject", refHashes: [HASH] }),
    ).rejects.toThrow(/FAL_KEY/);
  });

  it("resume re-attaches a poll loop to an in-flight record (restart recovery)", async () => {
    // Simulate a record left "training" by a previous process.
    await library.upsertTrainedLora({
      id: "t1",
      name: "Yue",
      status: "training",
      trainerId: "fake/trainer",
      jobId: "job-1",
      jobEndpoint: "fake-ai/trainer",
      jobStatusUrl: "https://q/fake/requests/job-1/status",
      jobResponseUrl: "https://q/fake/requests/job-1",
      steps: 1000,
    } as never);

    const svc = makeService(fakeTrainer([{ status: "ready", result: { loraUrl: "resumed", costUsd: 3 } }]));
    await svc.resume();
    const lib = await waitFor((l) => l.trainedLoras[0]?.status === "ready");
    expect(lib.trainedLoras[0]!.loraUrl).toBe("resumed"); // resumed without a fresh submit
  });

  it("resume fails records whose trainer no longer exists", async () => {
    await library.upsertTrainedLora({
      id: "t1",
      status: "training",
      trainerId: "gone/trainer",
      jobId: "job-1",
      jobStatusUrl: "https://q/fake/requests/job-1/status",
    } as never);
    const svc = makeService(fakeTrainer([{ status: "training" }]));
    await svc.resume();
    const lib = await library.get();
    expect(lib.trainedLoras[0]!.status).toBe("failed");
    expect(lib.trainedLoras[0]!.error).toMatch(/resume/i);
  });
});

describe("TrainingService — money-safety hardening", () => {
  it("resume leaves a job 'training' when FAL_KEY is transiently absent (never fails a paid job)", async () => {
    await library.upsertTrainedLora({
      id: "t1",
      status: "training",
      trainerId: "fake/trainer",
      jobId: "job-1",
      jobStatusUrl: "https://q/fake/requests/job-1/status",
      jobResponseUrl: "https://q/fake/requests/job-1",
      steps: 1000,
    } as never);
    const svc = makeService(fakeTrainer([{ status: "training" }]), { getApiKey: () => undefined });
    await svc.resume();
    const lib = await library.get();
    expect(lib.trainedLoras[0]!.status).toBe("training"); // NOT failed — resumes next boot
  });

  it("a submit failure marks the persisted intent record 'failed' (not discarded)", async () => {
    const throwing: TrainingAdapter = {
      ...fakeTrainer([]),
      async submit() {
        throw new Error("fal 400 bad dataset");
      },
    };
    const svc = makeService(throwing);
    await expect(
      svc.start({ trainerId: "fake/trainer", name: "X", kind: "subject", refHashes: [HASH] }),
    ).rejects.toThrow(/bad dataset/);
    const lib = await library.get();
    expect(lib.trainedLoras).toHaveLength(1); // intent persisted BEFORE submit — visible, recoverable
    expect(lib.trainedLoras[0]!.status).toBe("failed");
  });

  it("fails fast on a terminal fal error (401) instead of retrying to the deadline", async () => {
    let polls = 0;
    const terminal: TrainingAdapter = {
      ...fakeTrainer([]),
      async poll() {
        polls++;
        throw new FalHttpError(401, "unauthorized");
      },
    };
    const svc = makeService(terminal);
    await svc.start({ trainerId: "fake/trainer", name: "X", kind: "subject", refHashes: [HASH] });
    const lib = await waitFor((l) => l.trainedLoras[0]?.status === "failed");
    expect(lib.trainedLoras[0]!.error).toMatch(/401/);
    expect(polls).toBe(1); // terminal → did NOT retry
  });

  it("retries a transient HTTP error (503), not failing it", async () => {
    let polls = 0;
    const flaky: TrainingAdapter = {
      ...fakeTrainer([]),
      async poll(): Promise<TrainingPoll> {
        polls++;
        if (polls < 2) throw new FalHttpError(503, "service unavailable");
        return { status: "ready", result: { loraUrl: "u", costUsd: 1 } };
      },
    };
    const svc = makeService(flaky);
    await svc.start({ trainerId: "fake/trainer", name: "X", kind: "subject", refHashes: [HASH] });
    const lib = await waitFor((l) => l.trainedLoras[0]?.status === "ready");
    expect(lib.trainedLoras[0]!.loraUrl).toBe("u"); // 503 was retried, not terminal
  });

  it("anchors the deadline to the job's createdAt, so a restart doesn't reset the clock", async () => {
    // Seed a record that 'started' long ago by writing the library file directly
    // (upsert would stamp a fresh createdAt).
    await fs.writeFile(
      path.join(root, "library.json"),
      JSON.stringify({
        characters: [],
        styles: [],
        trainedLoras: [
          {
            id: "t1",
            status: "training",
            trainerId: "fake/trainer",
            jobId: "job-1",
            jobStatusUrl: "https://q/fake/requests/job-1/status",
            jobResponseUrl: "https://q/fake/requests/job-1",
            steps: 1000,
            createdAt: "2000-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const svc = makeService(fakeTrainer([{ status: "training" }]), { deadlineMs: 60_000 });
    await svc.resume();
    const lib = await waitFor((l) => l.trainedLoras[0]?.status === "failed");
    expect(lib.trainedLoras[0]!.error).toMatch(/timed out/); // year-2000 start + 1min budget = already past
  });
});
