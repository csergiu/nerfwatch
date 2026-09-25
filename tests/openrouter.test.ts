import { afterEach, describe, expect, it, vi } from "vitest";
import { MODELS } from "../src/models.ts";
import { buildBody, parseModel, registerOpenRouterModel, resultFromChunks } from "../src/providers/openrouter.ts";
import { generateQuestionSet } from "../src/questions/index.ts";
import type { Settings } from "../src/run.ts";

const set = generateQuestionSet(1);
const codeQ = set.questions.find((q) => q.category === "code")!;
const docQ = set.questions.find((q) => q.category === "long-context")!;
const settings = (model: string, effort = "high"): Settings => ({ model, effort, maxTokens: 16000 });

afterEach(() => vi.unstubAllGlobals());

describe("OpenRouter model ids", () => {
  it("reads the model and an optional pinned provider", () => {
    expect(parseModel("openrouter/google/gemini-3.1-pro")).toEqual({ slug: "google/gemini-3.1-pro", pin: undefined });
    expect(parseModel("openrouter/google/gemini-3.1-pro@google-vertex")).toEqual({ slug: "google/gemini-3.1-pro", pin: "google-vertex" });
  });

  it("adds a model from OpenRouter's list, with prices per million tokens", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "google/gemini-3.1-pro", name: "Google: Gemini 3.1 Pro", created: 1771459200, pricing: { prompt: "0.000002", completion: "0.000012", input_cache_read: "0.0000002" } }] }),
    }));
    await registerOpenRouterModel("openrouter/google/gemini-3.1-pro@google-vertex");
    expect(MODELS["openrouter/google/gemini-3.1-pro@google-vertex"]).toMatchObject({
      provider: "openrouter",
      name: "Gemini 3.1 Pro",
      price: { input: 2, output: 12, cachedInput: 0.2 },
    });
    await expect(registerOpenRouterModel("openrouter/nope/missing")).rejects.toThrow(/no model "nope\/missing"/);
  });
});

describe("OpenRouter requests", () => {
  it("never allows providers that may keep the questions, and pins the provider when asked", () => {
    const pinned = buildBody(codeQ, set, settings("openrouter/google/gemini-3.1-pro@google-vertex"));
    expect(pinned).toMatchObject({
      model: "google/gemini-3.1-pro",
      max_completion_tokens: 16000,
      reasoning: { effort: "high" },
      provider: { data_collection: "deny", require_parameters: true, order: ["google-vertex"], allow_fallbacks: false },
    });
    const open = buildBody(codeQ, set, settings("openrouter/google/gemini-3.1-pro"));
    expect(open.provider).toEqual({ data_collection: "deny", require_parameters: true });
  });

  it("leaves out the thinking setting for models that don't think", () => {
    expect(buildBody(codeQ, set, settings("openrouter/x/y", "none"))).not.toHaveProperty("reasoning");
  });

  it("puts the long document first", () => {
    const body = buildBody(docQ, set, settings("openrouter/x/y"));
    expect(body.messages[0].content[0].text).toBe(set.documents[docQ.documentId!]);
  });
});

describe("OpenRouter answers", () => {
  const s = settings("openrouter/google/gemini-3.1-pro");
  const chunk = (content: string, extra = {}) => ({ model: "google/gemini-3.1-pro", choices: [{ delta: { content } }], ...extra });

  it("joins the streamed text, grades it, and uses the cost OpenRouter reported", () => {
    const r = resultFromChunks(
      codeQ,
      [
        chunk("Working..."),
        chunk("\n" + codeQ.expected, { provider: "Google Vertex" }),
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1000, completion_tokens: 900, cost: 0.0123, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 850 } },
        },
      ],
      s,
    );
    expect(r).toMatchObject({ passed: true, stopReason: "end_turn", servedModel: "google/gemini-3.1-pro via Google Vertex", costUsd: 0.0123 });
    expect(r.usage).toEqual({ input: 400, cacheRead: 600, cacheWrite: 0, output: 900, thinking: 850 });
  });

  it("counts cut-off answers and filtered answers as failures", () => {
    const usage = { prompt_tokens: 100, completion_tokens: 16000, cost: 0.2 };
    const cut = resultFromChunks(codeQ, [chunk(codeQ.expected), { choices: [{ delta: {}, finish_reason: "length" }], usage }], s);
    expect(cut).toMatchObject({ passed: false, stopReason: "max_tokens" });
    const filtered = resultFromChunks(codeQ, [{ choices: [{ delta: {}, finish_reason: "content_filter" }], usage }], s);
    expect(filtered).toMatchObject({ passed: false, stopReason: "refusal" });
  });
});
