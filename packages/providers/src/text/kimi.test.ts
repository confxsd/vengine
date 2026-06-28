import { describe, it, expect } from "vitest";
import { createKimiModel, kimiModels, DEFAULT_KIMI_MODEL } from "./kimi.js";
import { TextProviderRegistry } from "./registry.js";

interface Captured {
  url?: string;
  body?: Record<string, unknown>;
  auth?: string | null;
}

/** Mock Moonshot's OpenAI-compatible /chat/completions endpoint. */
function mockKimiFetch(captured: Captured, reply = "revised text"): typeof fetch {
  return (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    captured.url = String(url);
    captured.body = JSON.parse(String(init?.body));
    captured.auth = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
    });
  }) as typeof fetch;
}

describe("kimi adapter", () => {
  it("posts to chat/completions with bearer auth and returns the reply", async () => {
    const captured: Captured = {};
    const out = await kimiModels.k2.complete(
      { messages: [{ role: "user", content: "hi" }] },
      { apiKey: "secret", fetch: mockKimiFetch(captured, "  enriched  ") },
    );
    expect(captured.url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(captured.auth).toBe("Bearer secret");
    expect(captured.body?.model).toBe(DEFAULT_KIMI_MODEL);
    expect(out.text).toBe("enriched"); // trimmed
    expect(out.model).toBe(DEFAULT_KIMI_MODEL);
  });

  it("throws a clear error when the API key is missing", async () => {
    await expect(
      kimiModels.k2.complete({ messages: [] }, {}),
    ).rejects.toThrow(/KIMI_KEY/);
  });

  it("surfaces a non-2xx response as an error", async () => {
    const fetchErr = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    await expect(
      kimiModels.k2.complete({ messages: [] }, { apiKey: "k", fetch: fetchErr }),
    ).rejects.toThrow(/401/);
  });

  it("honors a baseUrl override (e.g. the mainland endpoint)", async () => {
    const captured: Captured = {};
    const cn = createKimiModel({
      id: "kimi/cn",
      displayName: "Kimi CN",
      baseUrl: "https://api.moonshot.cn/v1/",
    });
    await cn.complete(
      { messages: [{ role: "user", content: "x" }] },
      { apiKey: "k", fetch: mockKimiFetch(captured) },
    );
    expect(captured.url).toBe("https://api.moonshot.cn/v1/chat/completions"); // trailing slash trimmed
  });
});

describe("TextProviderRegistry", () => {
  it("registers and resolves adapters", () => {
    const reg = new TextProviderRegistry().registerAll(Object.values(kimiModels));
    expect(reg.get("kimi/k2")?.provider).toBe("kimi");
    expect(reg.list()).toHaveLength(1);
    expect(() => reg.require("nope/none")).toThrow(/Unknown text model/);
  });
});
