import { describe, expect, it } from "vitest";
import { baselineSentence, buildTrack, compare, verdictSentence } from "../src/analysis.ts";
import type { Result, RunMeta } from "../src/run.ts";

const settings = { model: "claude-opus-5", effort: "high" as const, maxTokens: 16000 };

// A finished batch run on a given day, with `passed` out of 100 correct.
function batch(day: string, passed: number, info: Partial<RunMeta> = {}) {
  const run: RunMeta = {
    id: `${day}-batch`,
    kind: "batch",
    createdAt: `${day}T06:00:00.000Z`,
    settings,
    questionSetCreatedAt: "set-1",
    questionIds: [],
    ...info,
  };
  const results: Result[] = Array.from({ length: 100 }, (_, k) => ({
    questionId: `q${k}`,
    category: "code",
    level: 1,
    status: "ok",
    passed: k < passed,
    stopReason: "end_turn",
    usage: { input: 100, cacheWrite: 0, cacheRead: 0, output: 1000, thinking: 900 },
    costUsd: 0.01,
  }));
  return { run, results };
}

describe("baseline", () => {
  it("uses the first week of runs, and dates it from the first run", () => {
    const track = buildTrack([batch("2026-10-01", 80), batch("2026-09-25", 80), batch("2026-09-27", 80), batch("2026-09-29", 80)]);
    expect(track.baselineStart).toBe("2026-09-25T06:00:00.000Z");
    expect(track.baseline.map((r) => r.run.id)).toEqual(["2026-09-25-batch", "2026-09-27-batch", "2026-09-29-batch", "2026-10-01-batch"]);
    expect(track.verdict).toEqual({ kind: "building-baseline", until: "2026-10-02T06:00:00.000Z" });
  });

  it("explains the gap for a model released long before tracking began", () => {
    const track = buildTrack([batch("2026-09-25", 80, { modelReleasedAt: "2026-03-03T00:00:00Z", modelName: "Claude Opus 5" })]);
    expect(track.launchGapDays).toBe(206);
    expect(track.modelName).toBe("Claude Opus 5");
    expect(baselineSentence(track)).toBe(
      "Released Mar 3, 2026, 7 months before we started tracking it on Sep 25, 2026. " +
        "We can't test the past, so scores are compared with Sep 25, 2026, not with launch day.",
    );
  });

  it("calls it a launch baseline when tracking starts within a week of release", () => {
    const track = buildTrack([batch("2026-09-25", 80, { modelReleasedAt: "2026-09-22T00:00:00Z" })]);
    expect(baselineSentence(track)).toBe("Tracked since Sep 25, 2026, its launch week (released Sep 22, 2026).");
  });

  it("says so when the release date is unknown", () => {
    expect(baselineSentence(buildTrack([batch("2026-09-25", 80)]))).toMatch(/release date is unknown/);
  });
});

describe("verdict", () => {
  const baselineWeek = [batch("2026-09-25", 80), batch("2026-09-27", 80), batch("2026-09-29", 80), batch("2026-10-01", 80)];

  it("flags a clear drop", () => {
    const track = buildTrack([...baselineWeek, batch("2026-10-03", 65), batch("2026-10-05", 66), batch("2026-10-07", 64)]);
    expect(track.verdict.kind).toBe("worse");
    expect(verdictSentence(track.verdict)).toMatch(/^Worse than baseline: 65% in the last 3 runs vs 80% at baseline \(−15 points/);
  });

  it("doesn't flag normal noise", () => {
    const track = buildTrack([...baselineWeek, batch("2026-10-03", 78), batch("2026-10-05", 81), batch("2026-10-07", 77)]);
    expect(track.verdict.kind).toBe("no-change");
  });

  it("only compares the last 3 runs", () => {
    const old = [batch("2026-10-03", 50), batch("2026-10-05", 50)];
    const track = buildTrack([...baselineWeek, ...old, batch("2026-10-07", 80), batch("2026-10-09", 80), batch("2026-10-11", 80)]);
    expect(track.recent).toHaveLength(3);
    expect(track.verdict.kind).toBe("no-change");
  });

  it("gives a range that contains the difference", () => {
    const c = compare({ passed: 400, answered: 500 }, { passed: 210, answered: 300 });
    expect(c.diff).toBeCloseTo(-0.1);
    expect(c.range[0]).toBeLessThan(c.diff);
    expect(c.range[1]).toBeGreaterThan(c.diff);
  });
});

describe("usage signals", () => {
  it("counts cached input tokens too, so caching doesn't hide a counting change", () => {
    const run = batch("2026-09-25", 80);
    run.results = run.results.map((r) => ({ ...r, usage: { ...r.usage!, input: 40, cacheWrite: 30, cacheRead: 30 } }));
    expect(buildTrack([run]).batches[0].avgInput).toBe(100);
  });

  it("prices 100 answered questions, even when some errored", () => {
    const run = batch("2026-09-25", 80);
    run.results[0] = { ...run.results[0], status: "error", costUsd: 0, usage: undefined };
    expect(buildTrack([run]).batches[0].costPer100).toBeCloseTo(1); // 99 answers at $0.01 each
  });
});
