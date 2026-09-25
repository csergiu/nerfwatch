// Turns saved runs into what we publish: per model, a baseline, a recent window and a verdict.
import type { Effort, Result, RunMeta } from "./claude.ts";
import { CATEGORIES, type Category } from "./questions/index.ts";
import { listRuns, loadResults } from "./store.ts";

export const BASELINE_DAYS = 7; // finished batch runs in the first week form the baseline
export const RECENT_RUNS = 3; // compared against the baseline: about 6 days at one run every 2nd day
export const LAUNCH_WINDOW_DAYS = 7; // a baseline this close to release counts as a launch baseline

const DAY_MS = 86_400_000;

export type Tally = { passed: number; answered: number };

export type RunSummary = Tally & {
  run: RunMeta;
  date: string;
  byCategory: Record<Category, Tally>;
  avgInput: number; // tokens counted for our prompts, cached or not; should never move
  avgOutput: number;
  avgThinking: number;
  costPer100: number; // what 100 answered questions cost, at the prices saved with the run
  refused: number;
  medianSeconds?: number; // live probes only
};

export type Comparison = {
  baseline: number; // pass rate
  recent: number;
  diff: number; // recent - baseline, as a fraction
  range: [number, number]; // 95% range of the difference
};

export type Verdict =
  | { kind: "building-baseline"; until: string }
  | { kind: "no-change" | "worse" | "better"; comparison: Comparison };

// Scores are only comparable with the same model, effort and question set: one "track" each.
export type Track = {
  key: string;
  model: string;
  modelName: string;
  effort: Effort;
  releasedAt?: string;
  baselineStart: string;
  launchGapDays?: number; // days from release to the start of tracking
  batches: RunSummary[]; // oldest first
  probes: RunSummary[];
  baseline: RunSummary[];
  recent: RunSummary[];
  verdict: Verdict;
};

const trackKey = (run: RunMeta) => `${run.settings.model}|${run.settings.effort}|${run.questionSetCreatedAt}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

function summarize(run: RunMeta, results: Result[]): RunSummary {
  const ok = results.filter((r) => r.status === "ok");
  const tally = (rs: Result[]) => ({ passed: rs.filter((r) => r.passed).length, answered: rs.length });
  const seconds = ok.map((r) => r.latency?.totalSec).filter((s) => s !== undefined).sort((a, b) => a - b);
  return {
    run,
    date: run.createdAt,
    ...tally(ok),
    byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, tally(ok.filter((r) => r.category === c))])) as Record<Category, Tally>,
    avgInput: avg(ok.map((r) => r.usage!.input + r.usage!.cacheWrite + r.usage!.cacheRead)),
    avgOutput: avg(ok.map((r) => r.usage!.output)),
    avgThinking: avg(ok.map((r) => r.usage!.thinking)),
    costPer100: ok.length ? (sum(ok.map((r) => r.costUsd)) / ok.length) * 100 : 0,
    refused: ok.filter((r) => r.stopReason === "refusal").length,
    medianSeconds: seconds.length ? seconds[Math.floor(seconds.length / 2)] : undefined,
  };
}

export const pool = (runs: Tally[]): Tally => ({
  passed: sum(runs.map((r) => r.passed)),
  answered: sum(runs.map((r) => r.answered)),
});

// Difference of two pass rates with a 95% range. If the whole range is below zero, it got worse.
export function compare(baseline: Tally, recent: Tally): Comparison {
  const p1 = baseline.passed / baseline.answered;
  const p2 = recent.passed / recent.answered;
  const se = Math.sqrt((p1 * (1 - p1)) / baseline.answered + (p2 * (1 - p2)) / recent.answered);
  const diff = p2 - p1;
  return { baseline: p1, recent: p2, diff, range: [diff - 1.96 * se, diff + 1.96 * se] };
}

export function verdictFor(baseline: RunSummary[], recent: RunSummary[], baselineStart: string): Verdict {
  if (recent.length === 0) {
    return { kind: "building-baseline", until: new Date(Date.parse(baselineStart) + BASELINE_DAYS * DAY_MS).toISOString() };
  }
  const comparison = compare(pool(baseline), pool(recent));
  const [lo, hi] = comparison.range;
  return { kind: hi < 0 ? "worse" : lo > 0 ? "better" : "no-change", comparison };
}

export function buildTrack(runs: { run: RunMeta; results: Result[] }[]): Track {
  const sorted = [...runs].sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt));
  const batches = sorted.filter((r) => r.run.kind === "batch").map((r) => summarize(r.run, r.results));
  const probes = sorted.filter((r) => r.run.kind === "probe").map((r) => summarize(r.run, r.results));
  const first = sorted[0].run;
  const withInfo = sorted.find((r) => r.run.modelReleasedAt || r.run.modelName)?.run;

  const baselineStart = batches[0]?.date ?? first.createdAt;
  const baselineEnd = Date.parse(baselineStart) + BASELINE_DAYS * DAY_MS;
  const baseline = batches.filter((b) => Date.parse(b.date) < baselineEnd);
  const recent = batches.filter((b) => Date.parse(b.date) >= baselineEnd).slice(-RECENT_RUNS);

  const releasedAt = withInfo?.modelReleasedAt;
  return {
    key: trackKey(first),
    model: first.settings.model,
    modelName: withInfo?.modelName ?? first.settings.model,
    effort: first.settings.effort,
    releasedAt,
    baselineStart,
    launchGapDays: releasedAt ? Math.max(0, Math.floor((Date.parse(baselineStart) - Date.parse(releasedAt)) / DAY_MS)) : undefined,
    batches,
    probes,
    baseline,
    recent,
    verdict: verdictFor(baseline, recent, baselineStart),
  };
}

// Every track with at least one finished run, most recently active first.
export function loadTracks(): Track[] {
  const groups = new Map<string, { run: RunMeta; results: Result[] }[]>();
  for (const run of listRuns()) {
    const results = loadResults(run.id);
    if (!results) continue;
    const key = trackKey(run);
    groups.set(key, [...(groups.get(key) ?? []), { run, results }]);
  }
  return [...groups.values()]
    .map(buildTrack)
    .sort((a, b) => lastDate(b).localeCompare(lastDate(a)));
}

export const findTrack = (run: RunMeta) => loadTracks().find((t) => t.key === trackKey(run));

const lastDate = (t: Track) => [...t.batches, ...t.probes].map((r) => r.date).sort().at(-1) ?? "";

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function formatGap(days: number): string {
  if (days < 60) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.round(days / 30.44);
  return months < 24 ? `${months} months` : `${Math.round(days / 365.25)} years`;
}

// Why the baseline date matters: we can't go back and test a model before we started.
export function baselineSentence(track: Pick<Track, "releasedAt" | "baselineStart" | "launchGapDays">): string {
  const since = formatDate(track.baselineStart);
  if (!track.releasedAt || track.launchGapDays === undefined) {
    return `Tracked since ${since}. The release date is unknown, so we can't say what changed before then.`;
  }
  if (track.launchGapDays <= LAUNCH_WINDOW_DAYS) {
    return `Tracked since ${since}, its launch week (released ${formatDate(track.releasedAt)}).`;
  }
  return (
    `Released ${formatDate(track.releasedAt)}, ${formatGap(track.launchGapDays)} before we started tracking it on ${since}. ` +
    `We can't test the past, so scores are compared with ${since}, not with launch day.`
  );
}

export const signedPoints = (x: number) => {
  const n = Math.round(x * 100);
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0";
};

export const VERDICT_LABELS: Record<Verdict["kind"], string> = {
  "building-baseline": "Building baseline",
  "no-change": "No change detected",
  worse: "Worse than baseline",
  better: "Better than baseline",
};

// The numbers behind a verdict, for when its label is already shown.
export function verdictDetail(verdict: Verdict): string {
  if (verdict.kind === "building-baseline") return `Ready on ${formatDate(verdict.until)}. Until then there's nothing to compare with.`;
  const { baseline, recent, diff, range } = verdict.comparison;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    `${pct(recent)} in the last ${RECENT_RUNS} runs vs ${pct(baseline)} at baseline ` +
    `(${signedPoints(diff)} points, likely range ${signedPoints(range[0])} to ${signedPoints(range[1])}).`
  );
}

export function verdictSentence(verdict: Verdict): string {
  if (verdict.kind === "building-baseline") return `Building the baseline until ${formatDate(verdict.until)}.`;
  return `${VERDICT_LABELS[verdict.kind]}: ${verdictDetail(verdict)}`;
}
