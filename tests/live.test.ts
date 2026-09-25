import { describe, expect, it } from "vitest";
import { askLive } from "../src/live.ts";
import { generateQuestionSet } from "../src/questions/index.ts";
import { errorResult, type ProviderClient, type Result } from "../src/run.ts";

const set = generateQuestionSet(1);
const questions = set.questions.slice(0, 6);
const settings = { model: "m", effort: "high", maxTokens: 16000 };
const ok = (id: string): Result => ({ questionId: id, category: "code", level: 1, status: "ok", passed: true, costUsd: 0 });

// A provider that turns away the first `limited` calls with a 429.
function provider(limited: number, otherError = false) {
  let calls = 0;
  const client: ProviderClient = {
    fetchModelInfo: async () => ({}),
    runLive: async (q) => {
      calls++;
      if (calls <= limited) return errorResult(q, otherError ? "500 server error" : "429 Rate limit exceeded");
      return ok(q.id);
    },
  };
  return { client, calls: () => calls };
}

describe("live runs", () => {
  it("asks rate-limited questions again after a pause, and keeps the order", async () => {
    const p = provider(4);
    const pauses: number[] = [];
    const results = await askLive(p.client, questions, set, settings, { pauseMs: 0, onPause: (n) => pauses.push(n) });
    expect(results.map((r) => r.questionId)).toEqual(questions.map((q) => q.id));
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(pauses).toEqual([4]);
    expect(p.calls()).toBe(10);
  });

  it("asks the first question for each document before the others that share it", async () => {
    const withDocs = set.questions.filter((q) => q.documentId);
    const log: string[] = [];
    const client: ProviderClient = {
      fetchModelInfo: async () => ({}),
      runLive: async (q) => {
        log.push(`start ${q.id}`);
        await new Promise((r) => setTimeout(r, 1));
        log.push(`end ${q.id}`);
        return ok(q.id);
      },
    };
    const results = await askLive(client, withDocs, set, settings, { concurrency: 4 });
    expect(results.map((r) => r.questionId)).toEqual(withDocs.map((q) => q.id)); // still in question order
    for (const doc of new Set(withDocs.map((q) => q.documentId))) {
      const [first, ...rest] = withDocs.filter((q) => q.documentId === doc);
      const firstEnd = log.indexOf(`end ${first.id}`);
      for (const q of rest) expect(log.indexOf(`start ${q.id}`), `${q.id} waits for ${first.id}`).toBeGreaterThan(firstEnd);
    }
  });

  it("gives up after its retries, and never retries other errors", async () => {
    const stuck = await askLive(provider(1000).client, questions, set, settings, { pauseMs: 0, retries: 2 });
    expect(stuck.every((r) => r.status === "error")).toBe(true);
    const p = provider(3, true);
    const failed = await askLive(p.client, questions, set, settings, { pauseMs: 0 });
    expect(failed.filter((r) => r.status === "error")).toHaveLength(3);
    expect(p.calls()).toBe(6);
  });
});
