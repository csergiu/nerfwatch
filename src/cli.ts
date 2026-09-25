import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import { findTrack } from "./analysis.ts";
import { MODELS, modelInfo } from "./models.ts";
import { PROVIDER_LABELS, providerFor, usesBatchApi } from "./providers/index.ts";
import { isOpenRouterModel, registerOpenRouterModel } from "./providers/openrouter.ts";
import { generateQuestionSet, type Question, type QuestionSet } from "./questions/index.ts";
import { batchReport, probeReport } from "./report.ts";
import { DEFAULT_SETTINGS, estimateCost, type ProviderClient, type Result, type Settings } from "./run.ts";
import { createRun, listRuns, loadMeta, loadQuestionSet, loadResults, saveQuestionSet, saveResults } from "./store.ts";

const LIVE_CONCURRENCY = 4; // full runs without a batch API: questions asked at the same time

const HELP = `Usage: ./nerf <command> [options]

Commands:
  generate          Create the private question set (data/questions.json)
  submit            Run all questions: through the provider's batch API (half price) where
                    there is one, otherwise live
  collect [run]     Fetch the results of every finished batch run (or just one) and print the reports
  probe             Ask the 10 probe questions live, right now (also measures speed)
  report [run]      Print the report for a run (default: the latest)
  models            List the models you can test, with their thinking levels and prices

Options:
  --yes             Actually send requests. Without it, submit and probe only show the estimated cost.
  --model <id>      Default: ${DEFAULT_SETTINGS.model}. See ./nerf models, or use any
                    OpenRouter model as openrouter/<id>[@provider]
  --effort <level>  How much the model may think; levels depend on the model (default: ${DEFAULT_SETTINGS.effort})
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

async function settingsFromFlags(): Promise<Settings> {
  const model = values.model ?? DEFAULT_SETTINGS.model;
  if (isOpenRouterModel(model)) await registerOpenRouterModel(model); // looks it up in OpenRouter's model list
  const { efforts } = modelInfo(model); // fails early for models we don't know
  const effort = values.effort ?? DEFAULT_SETTINGS.effort;
  if (!efforts.includes(effort)) throw new Error(`--effort for ${model} must be one of: ${efforts.join(", ")}`);
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

// Asks questions live, a few at a time, showing progress.
async function askLive(provider: ProviderClient, questions: Question[], set: QuestionSet, settings: Settings) {
  const results: Result[] = [];
  let next = 0;
  const worker = async () => {
    while (next < questions.length) {
      const q = questions[next++];
      results.push(await provider.runLive(q, set, settings));
      process.stdout.write(`\r${results.length}/${questions.length} answered`);
    }
  };
  await Promise.all(Array.from({ length: LIVE_CONCURRENCY }, worker));
  process.stdout.write("\n");
  return results;
}

async function submit() {
  const set = loadQuestionSet();
  const settings = await settingsFromFlags();
  const batch = usesBatchApi(settings.model);
  const how = batch ? "via the Batch API" : `live (${PROVIDER_LABELS[modelInfo(settings.model).provider]} runs have no batch discount)`;
  printEstimate(set.questions.length, estimateCost(set, set.questions, settings, batch), settings, how);
  if (!values.yes) return console.log("\nNothing sent. Run again with --yes to send.");

  const provider = providerFor(settings.model);
  const base = {
    kind: "batch" as const,
    createdAt: new Date().toISOString(),
    settings,
    questionSetCreatedAt: set.createdAt,
    questionIds: set.questions.map((q) => q.id),
    ...(await provider.fetchModelInfo(settings.model)),
  };

  if (provider.batch) {
    const batchId = await provider.batch.submit(set, set.questions, settings);
    const run = createRun({ ...base, batchId });
    console.log(`\nSubmitted as run ${run.id} (batch ${batchId}).`);
    return console.log("Most batches finish within an hour, at most 24h. Then run: ./nerf collect");
  }

  // No batch API: ask everything now. The run's folder is claimed first, so a problem saving it
  // shows up before anything is paid for; its results are saved once every question is answered.
  const run = createRun(base);
  console.log("");
  const results = await askLive(provider, set.questions, set, settings);
  saveResults(run.id, results);
  console.log(`\n${batchReport(run, results, probeIds(set), findTrack(run))}`);
}

// Without a run id: every batch run still waiting for results, oldest first,
// so each report's baseline already includes the runs before it.
async function collect() {
  const runs = positionals[1]
    ? [loadMeta(positionals[1])]
    : listRuns("batch")
        .filter((r) => r.batchId && !loadResults(r.id))
        .reverse();
  if (!runs.length) return console.log("No batch run is waiting for results.");

  const set = loadQuestionSet();
  let unfinished = 0;

  for (const run of runs) {
    if (run.kind !== "batch") throw new Error(`${run.id} is a probe run, not a batch run.`);
    if (!run.batchId) throw new Error(`${run.id} was asked live, so its results were saved when it ran.`);
    if (set.createdAt !== run.questionSetCreatedAt) {
      console.error(`Skipped ${run.id}: it used a different question set than data/questions.json, so it can't be graded.`);
      process.exitCode = 1;
      continue;
    }

    const outcome = await providerFor(run.settings.model).batch!.collect(run, set);
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
  const settings = await settingsFromFlags();
  const questions = set.questions.filter((q) => q.probe);
  printEstimate(questions.length, estimateCost(set, questions, settings, false), settings, "live");
  if (!values.yes) return console.log("\nNothing sent. Run again with --yes to send.");

  const provider = providerFor(settings.model);
  const run = createRun({
    kind: "probe",
    createdAt: new Date().toISOString(),
    settings,
    questionSetCreatedAt: set.createdAt,
    questionIds: questions.map((q) => q.id),
    ...(await provider.fetchModelInfo(settings.model)),
  });
  console.log("");

  // One at a time, so response times aren't slowed by our own parallel requests.
  const results = [];
  for (const [k, q] of questions.entries()) {
    process.stdout.write(`[${k + 1}/${questions.length}] ${q.id} … `);
    const r = await provider.runLive(q, set, settings);
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

async function models() {
  const rows = [["model", "provider", "full runs", "effort levels", "input / output per 1M tokens"]];
  for (const [id, m] of Object.entries(MODELS)) {
    rows.push([
      id,
      PROVIDER_LABELS[m.provider],
      usesBatchApi(id) ? "batch API" : "live",
      m.efforts.join(", "),
      `${usd(m.price.input)} / ${usd(m.price.output)}`,
    ]);
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  for (const row of rows) console.log(row.map((cell, c) => cell.padEnd(widths[c])).join("   ").trimEnd());
  console.log("\nFull runs through a batch API cost half these prices. Each provider needs its API key in .env (see .env.example).");
  console.log("Any OpenRouter model also works, as openrouter/<id>, e.g. openrouter/google/gemini-3.1-pro (see README).");
}

const commands: Record<string, () => Promise<void>> = { generate, submit, collect, probe, report, models };

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
