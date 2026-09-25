// Files on disk: the question set in data/, one folder per run in runs/.
import fs from "node:fs";
import path from "node:path";
import type { QuestionSet } from "./questions/index.ts";
import type { Result, RunMeta } from "./run.ts";

const QUESTIONS_PATH = "data/questions.json";
const RUNS_DIR = "runs";

export function loadQuestionSet(): QuestionSet {
  if (!fs.existsSync(QUESTIONS_PATH)) throw new Error("No question set yet. Run: npm run nerf generate");
  return JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf8"));
}

export function saveQuestionSet(set: QuestionSet, force: boolean): string {
  if (fs.existsSync(QUESTIONS_PATH) && !force) {
    throw new Error(`${QUESTIONS_PATH} already exists. Replacing it breaks comparisons with past runs; use --force if you mean it.`);
  }
  fs.mkdirSync(path.dirname(QUESTIONS_PATH), { recursive: true });
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(set, null, 2));
  return QUESTIONS_PATH;
}

// Ids start with the time, so they sort by it, and include the model, so runs for different
// models started in the same minute don't collide. Creating the folder claims the id.
export function createRun(meta: Omit<RunMeta, "id">): RunMeta {
  const stamp = meta.createdAt.slice(0, 16).replace(/:/g, "");
  const base = `${stamp}-${meta.settings.model}-${meta.kind}`;
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    try {
      fs.mkdirSync(path.join(RUNS_DIR, id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const run = { ...meta, id };
    saveMeta(run);
    return run;
  }
}

export function saveMeta(run: RunMeta) {
  fs.writeFileSync(path.join(RUNS_DIR, run.id, "meta.json"), JSON.stringify(run, null, 2));
}

export function loadMeta(runId: string): RunMeta {
  const file = path.join(RUNS_DIR, runId, "meta.json");
  if (!fs.existsSync(file)) throw new Error(`No run named ${runId} in ${RUNS_DIR}/`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveResults(runId: string, results: Result[]) {
  fs.writeFileSync(path.join(RUNS_DIR, runId, "results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function loadResults(runId: string): Result[] | undefined {
  const file = path.join(RUNS_DIR, runId, "results.jsonl");
  if (!fs.existsSync(file)) return undefined;
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Newest first. Run ids start with a timestamp, so they sort by time.
export function listRuns(kind?: RunMeta["kind"]): RunMeta[] {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .filter((id) => fs.existsSync(path.join(RUNS_DIR, id, "meta.json")))
    .sort()
    .reverse()
    .map(loadMeta)
    .filter((run) => !kind || run.kind === kind);
}
