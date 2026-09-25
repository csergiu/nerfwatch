// Instruction following: write a few lines that obey checkable rules.
// Difficulty = number of rules on top of "exactly N lines".
import type { Rng } from "./rng.ts";
import type { Grade } from "./types.ts";

export type Rule =
  | { kind: "acrostic"; word: string }
  | { kind: "wordsPerLine"; count: number }
  | { kind: "avoidLetter"; letter: string }
  | { kind: "includeWord"; word: string; times: number }
  | { kind: "endWith"; mark: string }
  | { kind: "lowercase" };

export type InstructionSpec = { lines: number; rules: Rule[] };

const RULE_KINDS: Rule["kind"][] = ["acrostic", "wordsPerLine", "avoidLetter", "includeWord", "endWith", "lowercase"];

const TOPICS = [
  "the ocean at night",
  "a busy train station",
  "the first snow of winter",
  "an old library",
  "a thunderstorm",
  "a city waking up",
  "a mountain lake",
  "a market in summer",
];
const ACROSTIC_WORDS = [
  "WAVE", "MOON", "SONG", "GLOW", "DUSK", "KIND", "PATH", "LAMP",
  "RIVER", "STONE", "CLOUD", "FROST", "BLOOM", "LIGHT", "NORTH", "QUIET",
  "GARDEN", "SILVER", "WINTER", "CANDLE", "HARBOR", "MEADOW", "FOREST", "BRIDGE",
  "LANTERN", "HARVEST", "JOURNEY", "MORNING", "THUNDER", "BLOSSOM", "CRYSTAL", "PICTURE",
];
const INCLUDE_WORDS = ["light", "blue", "slow", "quiet", "wind", "gold", "deep", "cold"];
const AVOID_LETTERS = ["e", "a", "o", "i", "t", "n", "s"];
const END_MARKS = ["?", "!", ";"];

export function generateInstructions(rng: Rng, level: number): { prompt: string; expected: InstructionSpec } {
  const chosen = new Set(rng.shuffle(RULE_KINDS).slice(0, level));
  const topic = rng.pick(TOPICS);
  const letter = chosen.has("avoidLetter") ? rng.pick(AVOID_LETTERS) : undefined;
  const allowed = (word: string) => !letter || !word.toLowerCase().includes(letter);

  let lines = rng.int(4, 7);
  const rules: Rule[] = [];
  const text: string[] = [];

  // Fixed order keeps prompts readable and consistent.
  for (const kind of RULE_KINDS) {
    if (!chosen.has(kind)) continue;
    switch (kind) {
      case "acrostic": {
        const word = rng.pick(ACROSTIC_WORDS.filter(allowed));
        lines = word.length;
        rules.push({ kind, word });
        text.push(`The first letters of the lines must spell "${word}", in order.`);
        break;
      }
      case "wordsPerLine": {
        const count = rng.int(5, 8);
        rules.push({ kind, count });
        text.push(`Each line must have exactly ${count} words (words are separated by spaces).`);
        break;
      }
      case "avoidLetter":
        rules.push({ kind, letter: letter! });
        text.push(`Do not use the letter "${letter}" anywhere, in upper or lower case.`);
        break;
      case "includeWord": {
        const word = rng.pick(INCLUDE_WORDS.filter(allowed));
        const times = rng.int(2, 3);
        rules.push({ kind, word, times });
        text.push(`Use the word "${word}" exactly ${times} times in total.`);
        break;
      }
      case "endWith": {
        const mark = rng.pick(END_MARKS);
        rules.push({ kind, mark });
        text.push(`Every line must end with "${mark}".`);
        break;
      }
      case "lowercase":
        rules.push({ kind });
        text.push("Use only lowercase letters (no capital letters at all).");
        break;
    }
  }

  const prompt = [
    `Write exactly ${lines} lines about ${topic}.`,
    "",
    "Rules:",
    ...text.map((t) => `- ${t}`),
    "",
    `Output only the ${lines} lines: no title, numbering, bullets or commentary.`,
  ].join("\n");

  return { prompt, expected: { lines, rules } };
}

export function gradeInstructions(text: string, spec: InstructionSpec): Grade {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const joined = lines.join("\n");
  const failures: string[] = [];

  if (lines.length !== spec.lines) failures.push(`${lines.length} lines`);

  for (const rule of spec.rules) {
    switch (rule.kind) {
      case "acrostic": {
        const firsts = lines.map((l) => l.match(/[a-z]/i)?.[0].toLowerCase() ?? "").join("");
        if (firsts !== rule.word.toLowerCase()) failures.push(`first letters "${firsts}"`);
        break;
      }
      case "wordsPerLine": {
        const bad = lines.filter((l) => l.split(/\s+/).length !== rule.count).length;
        if (bad) failures.push(`${bad} lines with wrong word count`);
        break;
      }
      case "avoidLetter":
        if (joined.toLowerCase().includes(rule.letter)) failures.push(`used "${rule.letter}"`);
        break;
      case "includeWord": {
        const count = joined
          .toLowerCase()
          .split(/[^a-z]+/)
          .filter((w) => w === rule.word).length;
        if (count !== rule.times) failures.push(`"${rule.word}" used ${count} times`);
        break;
      }
      case "endWith": {
        const bad = lines.filter((l) => !l.endsWith(rule.mark)).length;
        if (bad) failures.push(`${bad} lines not ending with "${rule.mark}"`);
        break;
      }
      case "lowercase":
        if (/[A-Z]/.test(joined)) failures.push("has capitals");
        break;
    }
  }

  return failures.length ? { passed: false, note: failures.join("; ") } : { passed: true };
}
