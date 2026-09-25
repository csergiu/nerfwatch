import Anthropic from "@anthropic-ai/sdk";
import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import { findTrack } from "./analysis.ts";
import { collectBatch, DEFAULT_SETTINGS, estimateCost, fetchModelInfo, runLive, submitBatch, type Effort, type Settings } from "./claude.ts";
import { priceFor } from "./pricing.ts";
import { generateQuestionSet, type QuestionSet } from "./questions/index.ts";
import { batchReport, probeReport } from "./report.ts";
import { createRun, listRuns, loadMeta, loadQuestionSet, loadResults, saveQuestionSet, saveResults } from "./store.ts";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

const HELP = `Usage: ./nerf <command> [options]

Commands:
  generate          Create the private question set (data/questions.json)
  submit            Send all questions as one Batch API run (half price, results within 24h)
  collect [run]     Fetch the results of every finished batch run (or just one) and print the reports
  probe             Ask the 10 probe questions live, right now (also measures speed)
  report [run]      Print the report for a run (default: the latest)

Options:
  --yes             Actually send requests. Without it, submit and probe only show the estimated cost.
  --model <id>      Default: ${DEFAULT_SETTINGS.model}
  --effort <level>  ${EFFORTS.join(" | ")} (default: ${DEFAULT_SETTINGS.effort})
  --seed <n>        generate only (default: a random secret seed)
  --force           generate only: replace the existing question set
`;

const usd = (x: number) => `$${x.toFixed(2)}`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    yes: { type: "boolean" },
    model: { type: "string" },
    effort: { type: "string" },
    seed: { type: "string" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

function settingsFromFlags(): Settings {
  const model = values.model ?? DEFAULT_SETTINGS.model;
  priceFor(model); // fails early for models we can't price
  const effort = (values.effort ?? DEFAULT_SETTINGS.effort) as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`--effort must be one of: ${EFFORTS.join(", ")}`);
  return { ...DEFAULT_SETTINGS, model, effort };
}

const probeIds = (set: QuestionSet) => new Set(set.questions.filter((q) => q.probe).map((q) => q.id));

function printEstimate(count: number, est: ReturnType<typeof estimateCost>, settings: Settings, how: string) {
  console.log(`${count} questions → ${settings.model} (effort ${settings.effort}) ${how}.`);
  console.log(
    `Estimated cost: ~${usd(est.expected)}, assuming ~${est.assumedOutputTokens.toLocaleString("en-US")} output tokens per question.`,
  );
  console.log(`Worst case: ${usd(est.worstCase)}, if every answer used all ${settings.maxTokens.toLocaleString("en-US")} tokens.`);
}

async function generate() {
  // The generators are public, so the seed is what keeps the questions private. It's saved in the file, not printed.
  const seed = values.seed === undefined ? randomInt(1, 2 ** 31) : Number(values.seed);
  if (!Number.isInteger(seed)) throw new Error("--seed must be a whole number");
  const set = generateQuestionSet(seed);
  const file = saveQuestionSet(set, values.force ?? false);
  console.log(`Wrote ${set.questions.length} questions (${probeIds(set).size} in the live probe) to ${file}.`);
  console.log("Keep this file private: anyone with its seed can recreate your questions.");
  for (const [id, text] of Object.entries(set.documents)) {
    console.log(`  ${id}: ~${Math.round(text.length / 4).toLocaleString("en-US")} tokens`);
  }
}

async function submit() {
  const set = loadQuestionSet();
  const settings = settingsFromFlags();
  printEstimate(set.questions.length, estimateCost(set, set.questions, settings, true), settings, "via the Batch API");
  if (!values.yes) return console.log("\nNothing sent. Run again with --yes to send.");

  const client = new Anthropic();
  const modelInfo = await fetchModelInfo(client, settings.model);
  const batchId = await submitBatch(client, set, set.questions, settings);
  const run = createRun({
    kind: "batch",
    createdAt: new Date().toISOString(),
    settings,
    questionSetCreatedAt: set.createdAt,
    questionIds: set.questions.map((q) => q.id),
    batchId,
    ...modelInfo,
  });
  console.log(`\nSubmitted as run ${run.id} (batch ${batchId}).`);
  console.log("Most batches finish within an hour, at most 24h. Then run: ./nerf collect");
}

// Without a run id: every batch run still waiting for results, oldest first,
// so each report's baseline already includes the runs before it.
async function collect() {
  const runs = positionals[1] ? [loadMeta(positionals[1])] : listRuns("batch").filter((r) => !loadResults(r.id)).reverse();
  if (!runs.length) return console.log("No batch run is waiting for results.");

  const set = loadQuestionSet();
  const client = new Anthropic();
  let unfinished = 0;

  for (const run of runs) {
    if (run.kind !== "batch") throw new Error(`${run.id} is a probe run, not a batch run.`);
    if (set.createdAt !== run.questionSetCreatedAt) {
      console.error(`Skipped ${run.id}: it used a different question set than data/questions.json, so it can't be graded.`);
      process.exitCode = 1;
      continue;
    }

    const outcome = await collectBatch(client, run, set);
    if (!outcome.done) {
      const c = outcome.counts;
      console.log(`${run.id} isn't finished: ${c.processing} processing, ${c.succeeded} done, ${c.errored} errored.`);
      unfinished++;
      continue;
    }
    saveResults(run.id, outcome.results);
    console.log(`${batchReport(run, outcome.results, probeIds(set), findTrack(run))}\n`);
  }

  if (unfinished) {
    console.log(`${unfinished === 1 ? "1 run isn't" : `${unfinished} runs aren't`} finished yet. Run ./nerf collect again later.`);
  }
}

async function probe() {
  const set = loadQuestionSet();
  const settings = settingsFromFlags();
  const questions = set.questions.filter((q) => q.probe);
  printEstimate(questions.length, estimateCost(set, questions, settings, false), settings, "live");
  if (!values.yes) return console.log("\nNothing sent. Run again with --yes to send.");

  const client = new Anthropic();
  const run = createRun({
    kind: "probe",
    createdAt: new Date().toISOString(),
    settings,
    questionSetCreatedAt: set.createdAt,
    questionIds: questions.map((q) => q.id),
    ...(await fetchModelInfo(client, settings.model)),
  });
  console.log("");

  const results = [];
  for (const [k, q] of questions.entries()) {
    process.stdout.write(`[${k + 1}/${questions.length}] ${q.id} … `);
    const r = await runLive(client, q, set, settings);
    results.push(r);
    console.log(r.status === "error" ? `error: ${r.error}` : `${r.passed ? "passed" : "failed"} in ${r.latency!.totalSec.toFixed(1)}s`);
  }
  saveResults(run.id, results);
  console.log(`\n${probeReport(run, results, findTrack(run))}`);
}

async function report() {
  const run = positionals[1] ? loadMeta(positionals[1]) : listRuns().find((r) => loadResults(r.id));
  if (!run) return console.log("No finished runs yet.");
  const results = loadResults(run.id);
  if (!results) return console.log(`${run.id} has no results yet. For a batch run, try: ./nerf collect`);
  const track = findTrack(run);
  console.log(
    run.kind === "batch" ? batchReport(run, results, probeIds(loadQuestionSet()), track) : probeReport(run, results, track),
  );
}

const commands: Record<string, () => Promise<void>> = { generate, submit, collect, probe, report };

const command = commands[positionals[0]];
if (!command || values.help) {
  console.log(HELP);
} else {
  try {
    await command();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
