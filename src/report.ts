// Plain-text reports for a finished run.
import { baselineSentence, verdictSentence, type Track } from "./analysis.ts";
import type { Result, RunMeta } from "./run.ts";
import { CATEGORIES, LEVELS } from "./questions/index.ts";

// The schedule the monthly projection assumes: a full run every day, the live probe 4 times a day.
const RUNS_PER_MONTH = 30;
const PROBES_PER_RUN_DAY = 4;

const usd = (x: number) => `$${x.toFixed(2)}`;
const num = (x: number) => Math.round(x).toLocaleString("en-US");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2 : 0;
};

// 95% Wilson interval: the range the true pass rate likely sits in, given n questions.
export function wilson(passed: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = passed / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const denom = 1 + (z * z) / n;
  return [Math.max(0, (centre - margin) / denom), Math.min(1, (centre + margin) / denom)];
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("   "));
}

function header(run: RunMeta, mode: string, track: Track | undefined): string[] {
  const s = run.settings;
  const name = run.modelName ? `${run.modelName} (${s.model})` : s.model;
  const lines = [`NerfWatch · ${run.id}`, `${name} · effort ${s.effort} · up to ${num(s.maxTokens)} output tokens · ${mode}`];
  if (track?.batches.length) lines.push(baselineSentence(track), verdictSentence(track.verdict));
  else lines.push("No baseline yet: it starts with the first finished batch run.");
  return [...lines, ""];
}

function scoreLines(results: Result[]): string[] {
  const ok = results.filter((r) => r.status === "ok");
  const passed = ok.filter((r) => r.passed).length;
  const [lo, hi] = wilson(passed, ok.length);
  const refused = ok.filter((r) => r.stopReason === "refusal").length;
  const stoppedEarly = ok.filter((r) => r.stopReason !== "end_turn" && r.stopReason !== "refusal").length;
  const errors = results.length - ok.length;
  const served = [...new Set(ok.map((r) => r.servedModel))].join(", ");
  return [
    `Score: ${passed}/${ok.length} (${pct(passed / ok.length)}, likely range ${pct(lo)}–${pct(hi)})`,
    `Refused ${refused} · stopped early ${stoppedEarly} · errors ${errors} (errors don't count toward the score)`,
    `Answered by: ${served || "–"}`,
  ];
}

export function batchReport(run: RunMeta, results: Result[], probeIds: Set<string>, track?: Track): string {
  const ok = results.filter((r) => r.status === "ok");
  const viaBatch = Boolean(run.batchId);
  const lines = [...header(run, viaBatch ? "Batch API" : "asked live", track), ...scoreLines(results), ""];

  const rows = [["", "passed", ...LEVELS.map((l) => `L${l}`), "output/q", "thinking/q"]];
  for (const category of CATEGORIES) {
    const rs = ok.filter((r) => r.category === category);
    if (!rs.length) continue;
    const cell = (xs: Result[]) => `${xs.filter((r) => r.passed).length}/${xs.length}`;
    rows.push([
      category,
      cell(rs),
      ...LEVELS.map((l) => cell(rs.filter((r) => r.level === l))),
      num(avg(rs.map((r) => r.usage!.output))),
      num(avg(rs.map((r) => r.usage!.thinking))),
    ]);
  }
  lines.push(...table(rows), "(output/q and thinking/q are average tokens per question; output includes thinking)", "");

  const cost = sum(results.map((r) => r.costUsd));
  const priciest = [...ok].sort((a, b) => b.costUsd - a.costUsd)[0];
  const cacheRead = sum(ok.map((r) => r.usage!.cacheRead));
  const cacheWrite = sum(ok.map((r) => r.usage!.cacheWrite));
  lines.push(
    `Cost of this run: ${usd(cost)} ($${(cost / Math.max(ok.length, 1)).toFixed(3)} per question, ${viaBatch ? "Batch" : "live"} prices)`,
    priciest ? `Priciest question: ${priciest.questionId}, ${num(priciest.usage!.output)} output tokens, ${usd(priciest.costUsd)}` : "",
    `Cache: ${num(cacheRead)} input tokens read from cache, ${num(cacheWrite)} written`,
    "",
  );

  // Scale up if some questions errored, so the projection reflects a full run.
  const fullRunCost = ok.length ? (cost * run.questionIds.length) / ok.length : 0;
  // The probe is always live: twice the batch price, the same as a live full run.
  const probeCost = sum(ok.filter((r) => probeIds.has(r.questionId)).map((r) => r.costUsd)) * (viaBatch ? 2 : 1);
  const monthlyBatch = fullRunCost * RUNS_PER_MONTH;
  const monthlyProbe = probeCost * PROBES_PER_RUN_DAY * RUNS_PER_MONTH;
  lines.push(
    `Projected cost per model per month, with a run every day (${RUNS_PER_MONTH} runs):`,
    ...table([
      [`  Full run: ${run.questionIds.length} questions × ${RUNS_PER_MONTH} runs`, usd(monthlyBatch)],
      [`  Live probe: 10 questions × ${PROBES_PER_RUN_DAY} a day × ${RUNS_PER_MONTH} days`, usd(monthlyProbe)],
      ["  Total", `~${usd(monthlyBatch + monthlyProbe)}`],
    ]),
    "  (probe estimate uses this run's probe questions at live prices)",
    "",
  );

  const failures = ok.filter((r) => !r.passed);
  if (failures.length) {
    lines.push(`Some failures (all answers are in runs/${run.id}/results.jsonl):`);
    for (const r of failures.slice(0, 8)) lines.push(`  ${r.questionId}: ${r.note ?? ""}`);
    lines.push("");
  }

  lines.push(
    "Calibration: a level the model passes 5/5 is too easy, 0/5 too hard.",
    "Keep levels where it passes some of the time; that's where a drop shows up first.",
  );
  return lines.join("\n");
}

export function probeReport(run: RunMeta, results: Result[], track?: Track): string {
  const ok = results.filter((r) => r.status === "ok");
  const lines = [...header(run, "live", track), ...scoreLines(results), ""];

  const rows = [["question", "passed", "first text", "total", "output", "tokens/s"]];
  for (const r of results) {
    if (r.status === "error") {
      rows.push([r.questionId, "error", "", "", "", ""]);
      continue;
    }
    const { firstTextSec, totalSec } = r.latency!;
    rows.push([
      r.questionId,
      r.passed ? "yes" : "no",
      firstTextSec === null ? "–" : `${firstTextSec.toFixed(1)}s`,
      `${totalSec.toFixed(1)}s`,
      num(r.usage!.output),
      num(r.usage!.output / totalSec),
    ]);
  }
  lines.push(...table(rows), "");

  lines.push(
    `Cost: ${usd(sum(results.map((r) => r.costUsd)))} · median total time ${median(ok.map((r) => r.latency!.totalSec)).toFixed(1)}s`,
  );
  const errors = results.filter((r) => r.status === "error");
  for (const r of errors) lines.push(`  ${r.questionId}: ${r.error}`);
  return lines.join("\n");
}
