import { describe, it, expect } from "vitest";
import { openrouterModels, OPENROUTER_BASE_URL } from "./openrouter.js";

interface Captured {
  url?: string;
  body?: Record<string, unknown>;
  auth?: string | null;
}

/** Mock the OpenRouter OpenAI-compatible /chat/completions endpoint. */
function mockOpenRouterFetch(captured: Captured, reply = "parsed draft"): typeof fetch {
  return (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    captured.url = String(url);
    captured.body = JSON.parse(String(init?.body));
    captured.auth = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
    });
  }) as typeof fetch;
}

describe("openrouter adapter", () => {
  it("hits openrouter chat/completions with the GLM slug and OPENROUTER_KEY semantics", async () => {
    const captured: Captured = {};
    const out = await openrouterModels.glm.complete(
      { messages: [{ role: "user", content: "hi" }], temperature: 0.3, maxTokens: 512 },
      { apiKey: "or-secret", fetch: mockOpenRouterFetch(captured, "  parsed draft  ") },
    );
    expect(captured.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect(captured.auth).toBe("Bearer or-secret");
    expect(captured.body?.model).toBe("z-ai/glm-5.3-flash");
    expect(captured.body?.max_tokens).toBe(512);
    expect(out.text).toBe("parsed draft"); // trimmed
    expect(out.model).toBe("z-ai/glm-5.3-flash");
  });

  it("authenticates via the openrouter provider (OPENROUTER_KEY, not DEEPSEEK_KEY)", async () => {
    await expect(openrouterModels.glm.complete({ messages: [] }, {})).rejects.toThrow(
      /OPENROUTER_KEY/,
    );
    expect(openrouterModels.glm.provider).toBe("openrouter");
  });

  it("surfaces a provider error with its body (e.g. a balance failure)", async () => {
    const fetchErr = (async () =>
      new Response('{"error":{"message":"Insufficient Balance"}}', { status: 402 })) as typeof fetch;
    await expect(
      openrouterModels.glm.complete({ messages: [] }, { apiKey: "k", fetch: fetchErr }),
    ).rejects.toThrow(/402.*Insufficient Balance/s);
  });
});
