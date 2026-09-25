import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { costUsd } from "../src/models.ts";
import { generateQuestionSet, grade, type Question } from "../src/questions/index.ts";
import { generateInstructions, gradeInstructions, type InstructionSpec } from "../src/questions/instructions.ts";
import { createRng } from "../src/questions/rng.ts";
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
  it("has 100 questions: 5 categories x 5 levels x 4, with 10 probe questions", () => {
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
      else if (op === "Remove the largest element (if there's a tie, the first one).") {
        list.splice(list.indexOf(Math.max(...list)), 1);
      } else if (op === "Move the smallest element to the start (if there's a tie, the first one).") {
        const [min] = list.splice(list.indexOf(Math.min(...list)), 1);
        list.unshift(min);
      } else if ((m = op.match(/^Subtract the element at position (\d+) from the element at position (\d+)\.$/))) {
        list[Number(m[2]) - 1] -= list[Number(m[1]) - 1];
      } else if ((m = op.match(/^Add (\d+) to every element at an even position \(2, 4, 6 and so on\)\.$/))) {
        for (let k = 1; k < list.length; k += 2) list[k] += Number(m[1]);
      } else if ((m = op.match(/^Append the number of elements greater than (\d+)\.$/))) {
        list.push(list.filter((v) => v > Number(m![1])).length);
      } else if (op === "If the sum of all elements is even, reverse the list; otherwise remove the last element.") {
        if (list.reduce((a, b) => a + b) % 2 === 0) list.reverse();
        else list.pop();
      } else if (op === "If the first element is greater than the last, swap them; otherwise move the last element to the start.") {
        if (list[0] > list[list.length - 1]) [list[0], list[list.length - 1]] = [list[list.length - 1], list[0]];
        else list.unshift(list.pop()!);
      } else if ((m = op.match(/^Reverse the order of the elements from position (\d+) to position (\d+)\.$/))) {
        const [i, j] = [Number(m[1]), Number(m[2])];
        list.splice(i - 1, j - i + 1, ...list.slice(i - 1, j).reverse());
      } else if ((m = op.match(/^Move the last (\d+) elements to the start, keeping their order\.$/))) {
        list.unshift(...list.splice(list.length - Number(m[1])));
      } else if ((m = op.match(/^If the list contains (\d+), remove its first occurrence; otherwise append \1\.$/))) {
        const n = Number(m[1]);
        if (list.includes(n)) list.splice(list.indexOf(n), 1);
        else list.push(n);
      } else throw new Error(`Unknown operation: ${op}`);
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

describe("logic", () => {
  // Reads a puzzle from its text alone: who says what, as a check on one assignment of knights.
  function parse(prompt: string) {
    const names = prompt.match(/You meet \d+ people: (.+)\.\n/)![1].split(/, | and /);
    const at = (name: string) => {
      expect(names, name).toContain(name);
      return names.indexOf(name);
    };
    const checks: { speaker: number; holds: (k: boolean[]) => boolean }[] = [];
    for (const [, speaker, said] of prompt.matchAll(/^(\w+) says: "(.+)"$/gm)) {
      for (const sentence of said.split(/(?<=\.) /)) {
        let m: RegExpMatchArray | null;
        let holds: (k: boolean[]) => boolean;
        if ((m = sentence.match(/^(\w+) is a (knight|knave)\.$/))) {
          const [who, knight] = [at(m[1]), m[2] === "knight"];
          holds = (k) => k[who] === knight;
        } else if ((m = sentence.match(/^(\w+) and (\w+) are (the same kind|different kinds)\.$/))) {
          const [a, b, same] = [at(m[1]), at(m[2]), m[3] === "the same kind"];
          holds = (k) => (k[a] === k[b]) === same;
        } else if ((m = sentence.match(/^At least one of (\w+) and (\w+) is a knight\.$/))) {
          const [a, b] = [at(m[1]), at(m[2])];
          holds = (k) => k[a] || k[b];
        } else if ((m = sentence.match(/^If (\w+) is a knight, then (\w+) is a (knight|knave)\.$/))) {
          const [a, b, knight] = [at(m[1]), at(m[2]), m[3] === "knight"];
          holds = (k) => !k[a] || k[b] === knight;
        } else if ((m = sentence.match(/^At least (\d+) of (.+) are knights\.$/))) {
          const [n, group] = [Number(m[1]), m[2].split(/, | and /).map(at)];
          holds = (k) => group.filter((p) => k[p]).length >= n;
        } else if ((m = sentence.match(/^Exactly (\d+) of (.+) (?:is a|are) (knight|knave)s?\.$/))) {
          const [n, group, knight] = [Number(m[1]), m[2].split(/, | and /).map(at), m[3] === "knight"];
          holds = (k) => group.filter((p) => k[p] === knight).length === n;
        } else throw new Error(`Unknown statement: ${sentence}`);
        checks.push({ speaker: at(speaker), holds });
      }
    }
    return { names, checks };
  }

  const fits = (people: number, checks: ReturnType<typeof parse>["checks"]) => {
    const found: string[] = [];
    for (let mask = 0; mask < 1 << people; mask++) {
      const k = Array.from({ length: people }, (_, p) => ((mask >> p) & 1) === 1);
      if (checks.every((c) => c.holds(k) === k[c.speaker])) found.push(k.map(String).join());
    }
    return found;
  };

  it("has exactly one answer, the expected one, and needs every statement", () => {
    for (const q of byCategory("logic")) {
      const { names, checks } = parse(q.prompt);
      const found = fits(names.length, checks);
      expect(found, q.id).toHaveLength(1);
      const knights = names.filter((_, p) => found[0].split(",")[p] === "true").sort();
      expect(knights, q.id).toEqual(q.expected);
      checks.forEach((_, k) => expect(fits(names.length, checks.toSpliced(k, 1)).length, `${q.id} without #${k}`).toBeGreaterThan(1));
    }
  });

  it("grows from 4 to 16 people, and from level 4 nobody says outright who is a knight", () => {
    for (const q of byCategory("logic")) {
      expect(parse(q.prompt).names, q.id).toHaveLength([4, 5, 9, 12, 16][q.level - 1]);
      if (q.level >= 4) expect(q.prompt, q.id).not.toMatch(/"(?:[^"]*\. )?\w+ is a (?:knight|knave)\./);
    }
  });

  it("grades the names on the last line as a set", () => {
    const q = byCategory("logic")[0];
    const knights = q.expected;
    const knave = parse(q.prompt).names.find((n) => !knights.includes(n))!;
    expect(grade(q, `Working it out...\n${[...knights].reverse().join(", ")}`).passed).toBe(true);
    expect(grade(q, `Knights: ${knights.join(" and ")}.`).passed).toBe(true);
    expect(grade(q, [...knights, knave].join(", ")).passed).toBe(false);
    expect(grade(q, knights.slice(1).join(", ")).passed).toBe(false); // one missing
    expect(grade(q, `${knights.join(", ")}\nLet me double-check that.`).passed).toBe(false);
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

  it("reads and writes a list from level 4 on, and prints it", () => {
    for (const q of byCategory("code")) {
      const usesList = q.prompt.includes("xs = [");
      expect(usesList, q.id).toBe(q.level >= 4);
      if (usesList) expect(q.prompt, q.id).toContain("print(a, b, c, d, *xs)");
    }
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
  // Every combination of rules must be possible to satisfy.
  function expectPossible(id: string, { lines, rules }: InstructionSpec) {
    const letter = rules.find((r) => r.kind === "avoidLetter")?.letter;
    for (const r of rules) {
      if (r.kind === "acrostic" || r.kind === "telestich") {
        expect(r.word.length, id).toBe(lines);
        if (letter) expect(r.word.toLowerCase(), id).not.toContain(letter);
      }
      if (r.kind === "includeWord" && letter) expect(r.word, id).not.toContain(letter);
    }
    const acrostic = rules.find((r) => r.kind === "acrostic")?.word;
    const telestich = rules.find((r) => r.kind === "telestich")?.word;
    if (acrostic && telestich) expect(telestich, id).not.toBe(acrostic);
    const include = rules.find((r) => r.kind === "includeWord");
    const has = (kind: string) => rules.some((r) => r.kind === kind);
    // With alliteration, the required word needs a line starting with its letter; with growing words
    // too, it fits at most once per such line.
    if (acrostic && include && has("alliteration")) expect(acrostic, id).toContain(include.word[0].toUpperCase());
    if (include && has("alliteration") && has("increasing")) {
      const lineCount = acrostic ? [...acrostic.toLowerCase()].filter((c) => c === include.word[0]).length : lines;
      expect(include.times, id).toBeLessThanOrEqual(lineCount);
    }
    if (include && has("increasing")) expect(include.times, id).toBeLessThanOrEqual(lines);
    // About 4 to 5 letters a word, or with growing words, more than 2 + 3 + 4 + … letters.
    const perLine = rules.find((r) => r.kind === "wordsPerLine")?.count;
    const letters = rules.find((r) => r.kind === "lettersPerLine")?.count;
    if (perLine && letters && has("increasing")) {
      expect(letters, id).toBeGreaterThan(Array.from({ length: perLine }, (_, k) => k + 2).reduce((a, b) => a + b));
    } else if (perLine && letters) {
      expect(letters / perLine, id).toBeGreaterThanOrEqual(4);
      expect(letters / perLine, id).toBeLessThanOrEqual(5);
    }
    const noRepeat = rules.find((r) => r.kind === "noRepeat");
    if (noRepeat && include) expect(noRepeat.except, id).toBe(include.word);
  }

  it("never asks for something impossible", () => {
    for (const q of byCategory("instructions")) expectPossible(q.id, q.expected);
    // Many more combinations than one question set has, from the levels that stack the most rules.
    for (let seed = 1; seed <= 500; seed++) {
      for (const level of [3, 4, 5]) expectPossible(`seed ${seed} L${level}`, generateInstructions(createRng(seed), level).expected);
    }
  });

  it("gets harder with each level: more rules, and the hard kinds from level 3", () => {
    const hard = new Set(["lettersPerLine", "alliteration", "noRepeat", "increasing", "telestich"]);
    for (const q of byCategory("instructions")) {
      const kinds = q.expected.rules.map((r) => r.kind);
      expect(kinds, q.id).toHaveLength([2, 3, 4, 8, 10][q.level - 1]);
      expect(kinds.filter((k) => hard.has(k)), q.id).toHaveLength([0, 0, 1, 4, 5][q.level - 1]);
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

  it("checks letters per line, alliteration and repeated words", () => {
    const hard: InstructionSpec = {
      lines: 2,
      rules: [
        { kind: "lettersPerLine", count: 18 },
        { kind: "alliteration" },
        { kind: "noRepeat", except: "gold" },
      ],
    };
    const text = "gold grass glows gold\nsoft silver sand, sure";
    expect(gradeInstructions(text, hard)).toEqual({ passed: true });
    expect(gradeInstructions("gold grass glows gold\nsoft silver sands, sure", hard).passed).toBe(false); // 19 letters
    expect(gradeInstructions("gold grass glows gold\nsoft silver sand, pure", hard).passed).toBe(false); // p breaks it
    expect(gradeInstructions("gold grass glows gold\nsoft grass sand, sure", hard).passed).toBe(false); // "grass" twice
    expect(gradeInstructions("gold grass glows gold\nsoft silver sand, sure", { lines: 2, rules: [{ kind: "noRepeat" }] }).passed).toBe(false);
    expect(gradeInstructions("don't drift\ndo don't", { lines: 2, rules: [{ kind: "alliteration" }] }).passed).toBe(true);
    const growing: InstructionSpec = { lines: 2, rules: [{ kind: "increasing" }] };
    expect(gradeInstructions("we saw deep, frozen crystals!\nan old barn", growing).passed).toBe(true); // 2, 3, 4, 6, 8 and 2, 3, 4
    expect(gradeInstructions("we saw deep, frozen crystals!\nthe old barn", growing).passed).toBe(false); // 3 then 3
    const lastLetters: InstructionSpec = { lines: 3, rules: [{ kind: "telestich", word: "SUN" }] };
    expect(gradeInstructions("the stars!\nwarm glow, lingering blu\nand then the dawn", lastLetters).passed).toBe(true); // punctuation ignored
    expect(gradeInstructions("the stars!\nwarm glow, lingering blue\nand then the dawn", lastLetters).passed).toBe(false); // spells "sen"
  });
});

describe("long context", () => {
  // Answers each question using only the document text the model sees.
  function solveFromDocument(doc: string, prompt: string): string {
    const rows = doc
      .split("\n")
      .map((l) => l.match(/^Record (\d+) \| Name: (.+?) \| Department: (\w+) \| Office: (\S+) \| Badge: (\S+) \| Manager: Record (\d+)$/))
      .filter((m) => m !== null)
      .map(([, number, name, department, office, badge, manager]) => ({ number, name, department, office, badge, manager }));
    const byNumber = new Map(rows.map((r) => [r.number, r]));

    const managerOf = (r: (typeof rows)[number]) => byNumber.get(r.manager)!;
    let m = prompt.match(/people in the (\w+) department have a manager whose own manager works in the (\w+) department/);
    if (m) return String(rows.filter((r) => r.department === m![1] && managerOf(managerOf(r)).department === m![2]).length);
    m = prompt.match(/people in the (\w+) department have a manager who works in the (\w+) department/);
    if (m) return String(rows.filter((r) => r.department === m![1] && managerOf(r).department === m![2]).length);

    const name = prompt.match(/named (.+?)\./)![1];
    const start = rows.filter((r) => r.name === name);
    expect(start).toHaveLength(1);
    let person = start[0];
    const hops = 1 + (prompt.match(/then to that person's manager/g)?.length ?? 0);
    for (let k = 0; k < hops; k++) person = byNumber.get(person.manager)!;
    return person.badge;
  }

  it("expected answers match the document", () => {
    for (const q of byCategory("long-context")) {
      expect(solveFromDocument(set.documents[q.documentId!], q.prompt), q.id).toBe(q.expected);
    }
  });

  it("only counts things there are a few of, and never asks the same thing twice", () => {
    const questions = byCategory("long-context");
    for (const q of questions.filter((x) => /^\d+$/.test(x.expected))) expect(Number(q.expected), q.id).toBeGreaterThanOrEqual(3);
    expect(new Set(questions.map((q) => q.prompt)).size).toBe(questions.length);
  });

  it("grades the last badge code in the answer", () => {
    const q = byCategory("long-context")[0];
    expect(grade(q, `Their manager has badge A1-1111, whose manager has:\n${q.expected}`).passed).toBe(true);
    expect(grade(q, "A1-1111").passed).toBe(false);
    expect(grade(q, "I couldn't find that person.").passed).toBe(false);
  });

  it("grades the number on the last line for counts", () => {
    const q = byCategory("long-context").find((x) => /^\d+$/.test(x.expected))!;
    const n = Number(q.expected);
    expect(grade(q, `Records 0012 and 0450 report to them, and more.\n**${n}**`).passed).toBe(true);
    expect(grade(q, `${n} people\nWait, one more: ${n + 1}`).passed).toBe(false);
    expect(grade(q, "Badge K4-1234").passed).toBe(false);
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
