import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { costUsd } from "../src/pricing.ts";
import { generateQuestionSet, grade, type Question } from "../src/questions/index.ts";
import { gradeInstructions, type InstructionSpec } from "../src/questions/instructions.ts";
import { wilson } from "../src/report.ts";

const set = generateQuestionSet(1);
const byCategory = <C extends Question["category"]>(c: C) =>
  set.questions.filter((q): q is Extract<Question, { category: C }> => q.category === c);

const hasPython = (() => {
  try {
    execFileSync("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

describe("question set", () => {
  it("has 100 questions: 4 categories x 5 levels x 5, with 10 probe questions", () => {
    expect(set.questions).toHaveLength(100);
    expect(new Set(set.questions.map((q) => q.id)).size).toBe(100);
    expect(set.questions.filter((q) => q.probe)).toHaveLength(10);
  });

  it("is the same every time for the same seed", () => {
    expect(generateQuestionSet(1).questions).toEqual(set.questions);
    expect(generateQuestionSet(2).questions).not.toEqual(set.questions);
  });
});

describe("reasoning", () => {
  // Re-applies the operations as written in the prompt, independently of the generator.
  function solveFromPrompt(prompt: string): number[] {
    const list = prompt.match(/Start with this list: \[(.*)\]/)![1].split(", ").map(Number);
    for (const line of prompt.split("\n").filter((l) => /^\d+\. /.test(l))) {
      const op = line.replace(/^\d+\. /, "");
      let m: RegExpMatchArray | null;
      if ((m = op.match(/^Append (\d+) to the end\.$/))) list.push(Number(m[1]));
      else if ((m = op.match(/^Insert (\d+) at the start\.$/))) list.unshift(Number(m[1]));
      else if (op === "Remove the first element.") list.shift();
      else if (op === "Remove the last element.") list.pop();
      else if (op === "Reverse the list.") list.reverse();
      else if (op === "Move the first element to the end.") list.push(list.shift()!);
      else if ((m = op.match(/^Swap the elements at positions (\d+) and (\d+)\.$/))) {
        const [i, j] = [Number(m[1]) - 1, Number(m[2]) - 1];
        [list[i], list[j]] = [list[j], list[i]];
      } else if ((m = op.match(/^Add (\d+) to the element at position (\d+)\.$/))) list[Number(m[2]) - 1] += Number(m[1]);
      else throw new Error(`Unknown operation: ${op}`);
    }
    return list;
  }

  it("expected answers match the operations in the prompt", () => {
    for (const q of byCategory("reasoning")) expect(solveFromPrompt(q.prompt), q.id).toEqual(q.expected);
  });

  it("grades the last list in the answer", () => {
    const q = byCategory("reasoning")[0];
    const right = `[${q.expected.join(", ")}]`;
    const wrong = `[${q.expected.map((v) => v + 1).join(", ")}]`;
    expect(grade(q, `Working...\n\nFinal list:\n${right}`).passed).toBe(true);
    expect(grade(q, `First I got ${wrong}, but correcting that:\n${right}`).passed).toBe(true);
    expect(grade(q, wrong).passed).toBe(false);
    expect(grade(q, "I'm not sure.").passed).toBe(false);
  });
});

describe("code", () => {
  it.skipIf(!hasPython)("expected output matches what real Python prints", () => {
    const questions = byCategory("code");
    const programs = questions.map((q) => q.prompt.match(/```python\n([\s\S]*?)\n```/)![1]);
    // One Python process runs every program and returns what each one printed.
    const runner = [
      "import contextlib, io, json, sys",
      "outputs = []",
      "for program in json.load(sys.stdin):",
      "    buffer = io.StringIO()",
      "    with contextlib.redirect_stdout(buffer):",
      "        exec(program, {})",
      "    outputs.append(buffer.getvalue().strip())",
      "print(json.dumps(outputs))",
    ].join("\n");
    const stdout = execFileSync("python3", ["-c", runner], { input: JSON.stringify(programs), encoding: "utf8" });
    const outputs: string[] = JSON.parse(stdout);
    questions.forEach((q, k) => expect(outputs[k], q.id).toBe(q.expected));
  });

  it("grades the numbers on the last line", () => {
    const q = byCategory("code")[0];
    expect(grade(q, q.expected).passed).toBe(true);
    expect(grade(q, `Tracing the loop...\n\n\`\`\`\n${q.expected}\n\`\`\``).passed).toBe(true);
    expect(grade(q, `Output: ${q.expected}`).passed).toBe(true);
    expect(grade(q, `${q.expected} 1`).passed).toBe(false);
    expect(grade(q, `${q.expected}\nLet me double-check that.`).passed).toBe(false);
  });
});

describe("instructions", () => {
  it("never asks for something impossible", () => {
    for (const q of byCategory("instructions")) {
      const { lines, rules } = q.expected;
      const letter = rules.find((r) => r.kind === "avoidLetter")?.letter;
      for (const r of rules) {
        if (r.kind === "acrostic") {
          expect(r.word.length, q.id).toBe(lines);
          if (letter) expect(r.word.toLowerCase(), q.id).not.toContain(letter);
        }
        if (r.kind === "includeWord" && letter) expect(r.word, q.id).not.toContain(letter);
      }
    }
  });

  const spec: InstructionSpec = {
    lines: 3,
    rules: [
      { kind: "acrostic", word: "SUN" },
      { kind: "wordsPerLine", count: 4 },
      { kind: "avoidLetter", letter: "e" },
      { kind: "includeWord", word: "gold", times: 2 },
      { kind: "endWith", mark: "!" },
      { kind: "lowercase" },
    ],
  };
  const good = "sun burns gold now!\nup high, gold rays!\nno cloud in sight!";

  it("passes an answer that follows every rule", () => {
    expect(gradeInstructions(good, spec)).toEqual({ passed: true });
    expect(gradeInstructions(`\n${good}\n\n`, spec).passed).toBe(true); // blank lines are ignored
  });

  it("fails an answer that breaks any one rule", () => {
    const broken = [
      "sun burns gold now!\nup high, gold rays!", // 2 lines
      "sun burns gold now!\nup high, gold rays!\nall cloud in sight!", // spells SUA
      "sun burns gold now!\nup high, gold rays!\nno cloud is in sight!", // 5 words
      "sun burns gold now!\nup high, gold rays!\nno cloud we see!", // uses e
      "sun burns gold now!\nup high, warm rays!\nno cloud in sight!", // gold once
      "sun burns gold now!\nup high, gold rays!\nno cloud in sight.", // ends with .
      "Sun burns gold now!\nup high, gold rays!\nno cloud in sight!", // capital
      `Here you go:\n${good}`, // commentary
    ];
    for (const text of broken) expect(gradeInstructions(text, spec).passed, text).toBe(false);
  });
});

describe("long context", () => {
  // Follows the chain using only the document text the model sees.
  function solveFromDocument(doc: string, prompt: string): string {
    const rows = doc
      .split("\n")
      .map((l) => l.match(/^Record (\d+) \| Name: (.+?) \| .* \| Badge: (\S+) \| Manager: Record (\d+)$/))
      .filter((m) => m !== null)
      .map(([, number, name, badge, manager]) => ({ number, name, badge, manager }));
    const name = prompt.match(/named (.+?)\./)![1];
    const start = rows.filter((r) => r.name === name);
    expect(start).toHaveLength(1);
    const manager = rows.find((r) => r.number === start[0].manager)!;
    return rows.find((r) => r.number === manager.manager)!.badge;
  }

  it("expected badges match the chain in the document", () => {
    for (const q of byCategory("long-context")) {
      expect(solveFromDocument(set.documents[q.documentId!], q.prompt), q.id).toBe(q.expected);
    }
  });

  it("grades the last badge code in the answer", () => {
    const q = byCategory("long-context")[0];
    expect(grade(q, `Their manager has badge A1-1111, whose manager has:\n${q.expected}`).passed).toBe(true);
    expect(grade(q, "A1-1111").passed).toBe(false);
    expect(grade(q, "I couldn't find that person.").passed).toBe(false);
  });
});

describe("report math", () => {
  it("gives a sensible 95% range", () => {
    const [lo, hi] = wilson(50, 100);
    expect(lo).toBeCloseTo(0.404, 2);
    expect(hi).toBeCloseTo(0.596, 2);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it("prices tokens, with the batch discount", () => {
    const usage = { input: 1_000_000, cacheWrite: 0, cacheRead: 1_000_000, output: 1_000_000, thinking: 0 };
    expect(costUsd("claude-opus-5", usage, false)).toBeCloseTo(5 + 0.5 + 25);
    expect(costUsd("claude-opus-5", usage, true)).toBeCloseTo((5 + 0.5 + 25) / 2);
    expect(() => costUsd("unknown-model", usage, false)).toThrow();
  });
});
