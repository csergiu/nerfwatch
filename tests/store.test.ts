import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunMeta } from "../src/run.ts";
import { createRun, listRuns } from "../src/store.ts";

const home = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nerfwatch-"));
beforeAll(() => process.chdir(temp));
afterAll(() => {
  process.chdir(home);
  fs.rmSync(temp, { recursive: true, force: true });
});

const meta = (model: string): Omit<RunMeta, "id"> => ({
  kind: "batch",
  createdAt: "2026-09-25T06:00:12.000Z",
  settings: { model, effort: "high", maxTokens: 16000 },
  questionSetCreatedAt: "set",
  questionIds: [],
});

describe("run ids", () => {
  it("never reuse a folder, even for runs started in the same minute", () => {
    const ids = [createRun(meta("gpt-6-astra")), createRun(meta("grok-4.7")), createRun(meta("grok-4.7"))].map((r) => r.id);
    expect(ids).toEqual([
      "2026-09-25T0600-gpt-6-astra-batch",
      "2026-09-25T0600-grok-4.7-batch",
      "2026-09-25T0600-grok-4.7-batch-2",
    ]);
    expect(listRuns().map((r) => r.settings.model).sort()).toEqual(["gpt-6-astra", "grok-4.7", "grok-4.7"]);
  });

  it("turn OpenRouter ids into a single folder name", () => {
    const run = createRun(meta("openrouter/google/gemini-3.1-pro@google-vertex"));
    expect(run.id).toBe("2026-09-25T0600-openrouter_google_gemini-3.1-pro@google-vertex-batch");
    expect(listRuns().some((r) => r.id === run.id)).toBe(true);
  });
});
