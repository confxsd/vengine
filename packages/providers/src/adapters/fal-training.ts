import type {
  ProviderCtx,
  TrainedLoraResult,
  TrainingAdapter,
  TrainingHandle,
  TrainingInput,
  TrainingPoll,
} from "../types.js";
import { falSubmit, falPollStatus, falFetchResult } from "./fal-queue.js";
import { buildDatasetDataUri } from "./dataset.js";

const POLL_INTERVAL_MS = 3000;
/** Overall ceiling for the convenience `train()`; the durable server loop sets its own. */
const TRAIN_DEADLINE_MS = 45 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fal LoRA *trainer*, the training-side sibling of `createFalModel`. One config
 * per trainer endpoint; the body mapper hides each trainer's field names (FLUX.1's
 * `images_data_url`/`trigger_word` vs FLUX.2's `image_data_url`/`default_caption`),
 * and `parseResult` pulls the hosted weights URL out of the response. The output
 * `loraUrl` is exactly a `LoraInput.path`, so a trained character/style runs on the
 * existing LoRA-capable generation adapters with no further wiring.
 */
export interface FalTrainerConfig {
  id: string;
  displayName: string;
  /** fal training endpoint slug, e.g. "fal-ai/flux-2-trainer". */
  endpoint: string;
  /** Inference model id this trainer's LoRA is compatible with (e.g. "fal/flux-2-lora"). */
  baseModelId: string;
  trains: "subject" | "style" | "both";
  /** USD per training step (fal bills per step). */
  pricePerStep: number;
  /** Steps used when the input doesn't specify; the trainer's recommended default. */
  defaultSteps: number;
  /** Map neutral input + the inline dataset URI onto this trainer's request body. */
  mapInput: (input: TrainingInput, datasetDataUri: string, steps: number) => Record<string, unknown>;
}

/** fal File objects: `{ url, content_type, file_name, file_size }`. */
interface FalFile {
  url: string;
}
interface FalTrainResult {
  diffusers_lora_file?: FalFile;
  config_file?: FalFile;
}

function effectiveSteps(input: TrainingInput, config: FalTrainerConfig): number {
  return input.steps && input.steps > 0 ? input.steps : config.defaultSteps;
}

export function createFalTrainer(config: FalTrainerConfig): TrainingAdapter {
  return {
    id: config.id,
    provider: "fal",
    displayName: config.displayName,
    baseModelId: config.baseModelId,
    trains: config.trains,
    pricePerStep: config.pricePerStep,

    estimateCost(input: TrainingInput): number {
      return effectiveSteps(input, config) * config.pricePerStep;
    },

    async submit(input: TrainingInput, ctx: ProviderCtx): Promise<TrainingHandle> {
      if (!ctx.apiKey) {
        throw new Error(`Missing fal API key for trainer ${config.id}. Set FAL_KEY in the server env.`);
      }
      if (input.examples.length === 0) {
        throw new Error(`Trainer ${config.id}: no training images supplied.`);
      }
      const doFetch = ctx.fetch ?? fetch;
      const steps = effectiveSteps(input, config);
      // The dataset is built once here, at submit — never re-uploaded on poll/resume.
      const { dataUri } = await buildDatasetDataUri(input.examples);
      const body = config.mapInput(input, dataUri, steps);
      const handle = await falSubmit(doFetch, config.endpoint, body, ctx);
      return {
        jobId: handle.requestId,
        endpoint: config.endpoint,
        steps,
        statusUrl: handle.statusUrl,
        responseUrl: handle.responseUrl,
      };
    },

    async poll(handle: TrainingHandle, ctx: ProviderCtx): Promise<TrainingPoll> {
      const doFetch = ctx.fetch ?? fetch;
      const status = await falPollStatus(doFetch, handle.statusUrl, ctx);
      if (status !== "COMPLETED") return { status: "training" };

      const result = (await falFetchResult(doFetch, handle.responseUrl, ctx)) as FalTrainResult;
      const loraUrl = result.diffusers_lora_file?.url;
      if (!loraUrl) return { status: "failed", error: `trainer ${config.id} returned no LoRA weights file` };
      return {
        status: "ready",
        result: {
          loraUrl,
          configUrl: result.config_file?.url,
          costUsd: handle.steps * config.pricePerStep,
        },
      };
    },

    async train(
      input: TrainingInput,
      ctx: ProviderCtx,
      onStatus?: (status: string) => void,
    ): Promise<TrainedLoraResult> {
      const handle = await this.submit(input, ctx);
      const deadline = Date.now() + TRAIN_DEADLINE_MS;
      for (;;) {
        if (ctx.signal?.aborted) throw new Error(`training aborted for ${config.id}`);
        if (Date.now() > deadline) throw new Error(`training timed out for ${config.id}`);
        const poll = await this.poll(handle, ctx);
        onStatus?.(poll.status);
        if (poll.status === "ready" && poll.result) return poll.result;
        if (poll.status === "failed") throw new Error(poll.error ?? `training failed for ${config.id}`);
        await sleep(POLL_INTERVAL_MS);
      }
    },
  };
}

/** Curated fal trainers (prices indicative, mid-2026). */
export const falTrainers = {
  /**
   * Default trainer: same FLUX.2 family as the `fal/flux-2-lora` inference endpoint,
   * so train→infer stay visually consistent. Caption-driven (no trigger word) — the
   * concept is anchored by per-image captions or `default_caption`.
   * Fields: `image_data_url`, `steps`, `learning_rate`, `default_caption`.
   */
  flux2: createFalTrainer({
    id: "fal/flux-2-trainer",
    displayName: "FLUX.2 Trainer (character / style)",
    endpoint: "fal-ai/flux-2-trainer",
    baseModelId: "fal/flux-2-lora",
    trains: "both",
    pricePerStep: 0.008,
    defaultSteps: 1000,
    mapInput: (input, dataUri, steps) => {
      const body: Record<string, unknown> = { image_data_url: dataUri, steps };
      if (input.learningRate != null) body.learning_rate = input.learningRate;
      // FLUX.2 has no trigger word; it needs a default caption so missing-caption images
      // don't error the run. Prefer the caller's caption (built from the character's own
      // description); else the bare trigger token — never "a photo of …", which biases an
      // illustrated character toward photorealism.
      const fallback = input.defaultCaption?.trim() || input.triggerWord?.trim();
      if (fallback) body.default_caption = fallback;
      return body;
    },
  }),

  /**
   * FLUX.1 fast trainer: the classic character path — `trigger_word` + auto
   * segmentation/captioning (`create_masks`), or `is_style` for a style LoRA.
   * Cheaper/faster; pairs with the legacy `fal/flux-lora` inference endpoint.
   * Fields: `images_data_url`, `trigger_word`, `is_style`, `steps`, `create_masks`.
   */
  flux1Fast: createFalTrainer({
    id: "fal/flux-lora-fast-training",
    displayName: "FLUX.1 Fast Trainer (character / style)",
    endpoint: "fal-ai/flux-lora-fast-training",
    baseModelId: "fal/flux-lora",
    trains: "both",
    pricePerStep: 0.0006,
    defaultSteps: 1000,
    mapInput: (input, dataUri, steps) => {
      const body: Record<string, unknown> = { images_data_url: dataUri, steps };
      if (input.triggerWord) body.trigger_word = input.triggerWord;
      if (input.isStyle != null) body.is_style = input.isStyle;
      return body;
    },
  }),
} as const;
