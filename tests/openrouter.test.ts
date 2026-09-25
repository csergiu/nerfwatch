import { afterEach, describe, expect, it, vi } from "vitest";
import { MODELS } from "../src/models.ts";
import { usesBatchApi } from "../src/providers/index.ts";
import { buildBatch, buildBody, collectBatchResponse, parseModel, registerOpenRouterModel, resultFromChunks } from "../src/providers/openrouter.ts";
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

  it("puts the long document first, marked for the prompt cache", () => {
    const body = buildBody(docQ, set, settings("openrouter/x/y"));
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: set.documents[docQ.documentId!], cache_control: { type: "ephemeral" } });
    expect(body.messages[0].content[1]).toEqual({ type: "text", text: docQ.prompt }); // the question itself differs, so it isn't cached
    expect(buildBody(codeQ, set, settings("openrouter/x/y")).messages[0].content).toEqual([{ type: "text", text: codeQ.prompt }]);
    const batched = buildBatch(set, [docQ], settings("openrouter/x/y@p")).requests[0].body;
    expect(batched.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
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

describe("OpenRouter batches", () => {
  const s = settings("openrouter/anthropic/claude-opus-5.5@anthropic");
  const run = { id: "r", kind: "batch" as const, createdAt: "", settings: s, questionSetCreatedAt: set.createdAt, questionIds: [codeQ.id, docQ.id], batchId: "batch_1" };

  it("puts the settings before the requests, as OpenRouter requires, with only the pin as routing", () => {
    const body = buildBatch(set, [codeQ, docQ], s);
    expect(Object.keys(body)).toEqual(["endpoint", "model", "provider", "completion_window", "requests"]);
    expect(body).toMatchObject({ endpoint: "/v1/chat/completions", model: "anthropic/claude-opus-5.5", provider: { only: ["anthropic"] } });
    expect(body.requests[0].custom_id).toBe(codeQ.id);
    expect(body.requests[0].body).toMatchObject({ max_completion_tokens: 16000, reasoning: { effort: "high" } });
    expect(body.requests[0].body).not.toHaveProperty("stream");
    expect(body.requests[0].body).not.toHaveProperty("model");
    expect(Object.keys(buildBatch(set, [codeQ], settings("openrouter/x/y")))).not.toContain("provider");
  });

  it("reports progress while the batch runs", () => {
    const status = collectBatchResponse({ status: "in_progress", request_counts: { total: 2, completed: 1, failed: 0 } }, run, set);
    expect(status).toEqual({ done: false, counts: { processing: 1, succeeded: 1, errored: 0 } });
  });

  it("grades finished results, prices them at batch rates when no cost is reported, and marks gaps", () => {
    MODELS["openrouter/anthropic/claude-opus-5.5@anthropic"] = { provider: "openrouter", name: "Claude Opus 5.5", efforts: ["high"], price: { input: 4, cachedInput: 0.4, output: 20 }, batch: true };
    const status = collectBatchResponse(
      {
        status: "completed",
        request_counts: { total: 2, completed: 1, failed: 0 },
        results: [
          {
            custom_id: codeQ.id,
            response: { status_code: 200, body: { model: "anthropic/claude-opus-5.5", choices: [{ message: { content: codeQ.expected }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } } },
          },
        ],
      },
      run,
      set,
    );
    if (!status.done) throw new Error("expected done");
    const byId = Object.fromEntries(status.results.map((r) => [r.questionId, r]));
    expect(byId[codeQ.id]).toMatchObject({ passed: true, stopReason: "end_turn" });
    expect(byId[codeQ.id].costUsd).toBeCloseTo((1000 * 4 + 1000 * 20) / 1e6 / 2); // half the list price
    expect(byId[docQ.id]).toMatchObject({ status: "error", error: "no result: batch completed" });
  });

  it("uses the Batch API only when the model has a batch variant served by the pinned provider", async () => {
    const stub = (endpoints: string[]) =>
      vi.stubGlobal("fetch", async (url: string) => ({
        ok: true,
        json: async () =>
          url.endsWith("/endpoints")
            ? { data: { endpoints: endpoints.map((tag) => ({ tag })) } }
            : { data: [{ id: "anthropic/claude-opus-5.5" }, { id: "anthropic/claude-opus-5.5:batch" }] },
      }));
    stub(["anthropic"]);
    await registerOpenRouterModel("openrouter/anthropic/claude-opus-5.5@anthropic");
    expect(usesBatchApi("openrouter/anthropic/claude-opus-5.5@anthropic")).toBe(true);
    stub(["anthropic"]);
    await registerOpenRouterModel("openrouter/anthropic/claude-opus-5.5@google-vertex");
    expect(usesBatchApi("openrouter/anthropic/claude-opus-5.5@google-vertex")).toBe(false);
  });
});
