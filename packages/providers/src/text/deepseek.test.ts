import { describe, it, expect } from "vitest";
import { createDeepSeekModel, deepseekModels, DEFAULT_DEEPSEEK_MODEL } from "./deepseek.js";
import { TextProviderRegistry } from "./registry.js";

interface Captured {
  url?: string;
  body?: Record<string, unknown>;
  auth?: string | null;
}

/** Mock DeepSeek's OpenAI-compatible /chat/completions endpoint. */
function mockDeepSeekFetch(captured: Captured, reply = "revised text"): typeof fetch {
  return (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    captured.url = String(url);
    captured.body = JSON.parse(String(init?.body));
    captured.auth = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
    });
  }) as typeof fetch;
}

describe("deepseek adapter", () => {
  it("posts to chat/completions with bearer auth and returns the reply", async () => {
    const captured: Captured = {};
    const out = await deepseekModels.chat.complete(
      { messages: [{ role: "user", content: "hi" }] },
      { apiKey: "secret", fetch: mockDeepSeekFetch(captured, "  enriched  ") },
    );
    expect(captured.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(captured.auth).toBe("Bearer secret");
    expect(captured.body?.model).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(out.text).toBe("enriched"); // trimmed
    expect(out.model).toBe(DEFAULT_DEEPSEEK_MODEL);
  });

  it("throws a clear error when the API key is missing", async () => {
    await expect(
      deepseekModels.chat.complete({ messages: [] }, {}),
    ).rejects.toThrow(/DEEPSEEK_KEY/);
  });

  it("surfaces a non-2xx response as an error", async () => {
    const fetchErr = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    await expect(
      deepseekModels.chat.complete({ messages: [] }, { apiKey: "k", fetch: fetchErr }),
    ).rejects.toThrow(/401/);
  });

  it("honors a baseUrl override", async () => {
    const captured: Captured = {};
    const alt = createDeepSeekModel({
      id: "deepseek/alt",
      displayName: "DeepSeek Alt",
      baseUrl: "https://api.deepseek.com/beta/",
    });
    await alt.complete(
      { messages: [{ role: "user", content: "x" }] },
      { apiKey: "k", fetch: mockDeepSeekFetch(captured) },
    );
    expect(captured.url).toBe("https://api.deepseek.com/beta/chat/completions"); // trailing slash trimmed
  });
});

describe("TextProviderRegistry", () => {
  it("registers and resolves adapters", () => {
    const reg = new TextProviderRegistry().registerAll(Object.values(deepseekModels));
    expect(reg.get("deepseek/chat")?.provider).toBe("deepseek");
    expect(reg.list()).toHaveLength(1);
    expect(() => reg.require("nope/none")).toThrow(/Unknown text model/);
  });
});
