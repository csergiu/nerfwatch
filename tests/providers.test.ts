import type { Response } from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";
import { buildParams as claudeParams } from "../src/providers/anthropic.ts";
import { usesBatchApi } from "../src/providers/index.ts";
import { buildParams, RESPONSES_PROVIDERS, toResult, usageOf } from "../src/providers/responses.ts";
import { costUsd, MODELS } from "../src/models.ts";
import { generateQuestionSet } from "../src/questions/index.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/run.ts";

const set = generateQuestionSet(1);
const codeQ = set.questions.find((q) => q.category === "code")!;
const docQ = set.questions.find((q) => q.category === "long-context")!;
const settings: Settings = { model: "gpt-6-astra", effort: "high", maxTokens: 16000 };

// The parts of a Responses API reply that NerfWatch reads.
function reply(parts: object[], extra: Partial<Response> = {}): Response {
  return {
    model: "gpt-6-astra-2026-09-03",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: parts }],
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
      output_tokens: 900,
      output_tokens_details: { reasoning_tokens: 850 },
      total_tokens: 1900,
    },
    ...extra,
  } as unknown as Response;
}

describe("model list", () => {
  it("lets every model use the default effort", () => {
    for (const [id, m] of Object.entries(MODELS)) expect(m.efforts, id).toContain(DEFAULT_SETTINGS.effort);
  });

  it("never includes Meta's contributor tier, which may train on what we send", () => {
    expect(Object.keys(MODELS).filter((id) => id.includes("contributor"))).toEqual([]);
  });

  it("knows which providers get batch prices", () => {
    expect(usesBatchApi("claude-opus-5")).toBe(true);
    expect(usesBatchApi("gpt-6-astra")).toBe(true);
    expect(usesBatchApi("grok-4.7")).toBe(false);
    expect(usesBatchApi("muse-spark-1.3")).toBe(false);
  });

  it("prices cache writes at the input price when a model has no separate rate", () => {
    const usage = { input: 0, cacheWrite: 1_000_000, cacheRead: 0, output: 0, thinking: 0 };
    expect(costUsd("gpt-6-astra", usage, false)).toBeCloseTo(12.5);
    expect(costUsd("grok-4.7", usage, false)).toBeCloseTo(2);
  });
});

describe("Responses API requests", () => {
  it("pins the effort and output limit", () => {
    const p = buildParams(codeQ, set, settings, RESPONSES_PROVIDERS.openai);
    expect(p).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "high" }, max_output_tokens: 16000 });
    expect(p).not.toHaveProperty("prompt_cache_key");
  });

  it("puts the long document first, grouped for caching where the provider supports it", () => {
    const p = buildParams(docQ, set, settings, RESPONSES_PROVIDERS.xai);
    const content = (p.input as { content: { text: string }[] }[])[0].content;
    expect(content[0].text).toBe(set.documents[docQ.documentId!]);
    expect(content[1].text).toBe(docQ.prompt);
    expect(p.prompt_cache_key).toBe(docQ.documentId);
    expect(buildParams(docQ, set, settings, RESPONSES_PROVIDERS.meta)).not.toHaveProperty("prompt_cache_key");
  });

  it("matches the Claude request on the settings that matter", () => {
    const p = claudeParams(codeQ, set, { ...settings, model: "claude-opus-5" });
    expect(p).toMatchObject({ max_tokens: 16000, output_config: { effort: "high" }, thinking: { type: "adaptive" } });
  });
});

describe("Responses API answers", () => {
  it("grades the text and records who answered", () => {
    const r = toResult(codeQ, reply([{ type: "output_text", text: codeQ.expected }]), settings, false);
    expect(r).toMatchObject({ passed: true, stopReason: "end_turn", servedModel: "gpt-6-astra-2026-09-03" });
  });

  it("counts cached tokens and cache writes separately from new input", () => {
    expect(usageOf(reply([]))).toEqual({ input: 300, cacheRead: 600, cacheWrite: 100, output: 900, thinking: 850 });
  });

  it("treats a refusal as a failed answer", () => {
    const r = toResult(codeQ, reply([{ type: "refusal", refusal: "I can't help with that." }]), settings, false);
    expect(r).toMatchObject({ passed: false, stopReason: "refusal", note: "refused" });
  });

  it("treats an answer cut off at the token limit as a failure, even if it looks right", () => {
    const cut = reply([{ type: "output_text", text: codeQ.expected }], {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    expect(toResult(codeQ, cut, settings, false)).toMatchObject({ passed: false, stopReason: "max_tokens" });
  });

  it("records a failed response as an error, which doesn't count toward the score", () => {
    const failed = reply([], { status: "failed", error: { code: "server_error", message: "boom" } } as Partial<Response>);
    expect(toResult(codeQ, failed, settings, false)).toMatchObject({ status: "error", error: "boom" });
  });

  it("halves the cost for batch answers", () => {
    const live = toResult(codeQ, reply([{ type: "output_text", text: "1" }]), settings, false);
    const batch = toResult(codeQ, reply([{ type: "output_text", text: "1" }]), settings, true);
    expect(batch.costUsd).toBeCloseTo(live.costUsd / 2);
  });
});
