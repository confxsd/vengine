import type { TrainingHost } from "../../server/src/library.js";
import type { StartTrainingParams } from "../../server/src/training.js";
import type { TrainedLora } from "@vengine/shared";
import type { Env } from "./env.js";
import { FEED_ID } from "./feed-do.js";

/**
 * Training through the Feed DO — submit + fal polling run inside the object,
 * which has a 30s CPU budget for the dataset zip build and survives across
 * alarm invocations while a job trains. The persisted library row stays the
 * source of truth; WS events are hints, exactly like the Node server.
 */
export class DoTrainingHost implements TrainingHost {
  constructor(private readonly env: Env) {}

  private stub() {
    return this.env.FEED.get(this.env.FEED.idFromName(FEED_ID));
  }

  async start(params: StartTrainingParams): Promise<TrainedLora> {
    return this.stub().trainingStart(params);
  }

  async remove(id: string): Promise<void> {
    await this.stub().trainingRemove(id);
  }
}
