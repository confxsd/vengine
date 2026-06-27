import type { AssetStore } from "@vengine/storage";

/**
 * Augment the core's ExecutionServices with the concrete services our nodes
 * need. Declaration merging keeps @vengine/core free of dependencies on the
 * storage/provider packages while giving nodes typed access via ctx.services.
 */
declare module "@vengine/core" {
  interface ExecutionServices {
    assets: AssetStore;
    /** Resolve a provider's API key. Server-side only; never exposed to the client. */
    getApiKey?: (provider: string) => string | undefined;
  }
}

export {};
