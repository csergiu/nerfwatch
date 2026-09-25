// Instruction following: write a few lines that obey checkable rules.
// Difficulty = more rules on top of "exactly N lines", and from level 3 on, rules that need
// counting or planning every word (letters per line, alliteration, no repeated words).
import type { Rng } from "./rng.ts";
import type { Grade } from "./types.ts";

export type Rule =
  | { kind: "acrostic"; word: string }
  | { kind: "wordsPerLine"; count: number }
  | { kind: "avoidLetter"; letter: string }
  | { kind: "includeWord"; word: string; times: number }
  | { kind: "endWith"; mark: string }
  | { kind: "lowercase" }
  | { kind: "lettersPerLine"; count: number }
  | { kind: "alliteration" }
  | { kind: "noRepeat"; except?: string };

export type InstructionSpec = { lines: number; rules: Rule[] };

const BASIC: Rule["kind"][] = ["acrostic", "wordsPerLine", "avoidLetter", "includeWord", "endWith", "lowercase"];
const HARD: Rule["kind"][] = ["lettersPerLine", "alliteration", "noRepeat"];
const LEVELS = [
  { basic: 2, hard: 0 },
  { basic: 3, hard: 0 },
  { basic: 3, hard: 1 },
  { basic: 4, hard: 1 },
  { basic: 4, hard: 2 },
];

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

// Words as the graders see them: lowercase letters, keeping apostrophes inside words ("don't").
const words = (text: string) => text.toLowerCase().match(/[a-z]+(?:['’][a-z]+)*/g) ?? [];

export function generateInstructions(rng: Rng, level: number): { prompt: string; expected: InstructionSpec } {
  const counts = LEVELS[level - 1];
  const chosen = new Set([...rng.shuffle(BASIC).slice(0, counts.basic), ...rng.shuffle(HARD).slice(0, counts.hard)]);
  const topic = rng.pick(TOPICS);
  const letter = chosen.has("avoidLetter") ? rng.pick(AVOID_LETTERS) : undefined;
  const allowed = (word: string) => !letter || !word.toLowerCase().includes(letter);

  // With alliteration, a required word can only go on a line whose words start with its first letter,
  // so an acrostic must include that letter.
  const fits = (include: string, acrostic?: string) =>
    allowed(include) && !(acrostic && chosen.has("alliteration") && !acrostic.includes(include[0].toUpperCase()));
  const acrostic = chosen.has("acrostic")
    ? rng.pick(ACROSTIC_WORDS.filter((w) => allowed(w) && (!chosen.has("includeWord") || INCLUDE_WORDS.some((i) => fits(i, w)))))
    : undefined;
  const include = chosen.has("includeWord") ? rng.pick(INCLUDE_WORDS.filter((i) => fits(i, acrostic))) : undefined;

  let lines = rng.int(4, 7);
  let wordsPerLine: number | undefined;
  const rules: Rule[] = [];
  const text: string[] = [];

  // Fixed order keeps prompts readable and consistent.
  for (const kind of [...BASIC, ...HARD]) {
    if (!chosen.has(kind)) continue;
    switch (kind) {
      case "acrostic":
        lines = acrostic!.length;
        rules.push({ kind, word: acrostic! });
        text.push(`The first letters of the lines must spell "${acrostic}", in order.`);
        break;
      case "wordsPerLine":
        wordsPerLine = rng.int(5, 8);
        rules.push({ kind, count: wordsPerLine });
        text.push(`Each line must have exactly ${wordsPerLine} words (words are separated by spaces).`);
        break;
      case "avoidLetter":
        rules.push({ kind, letter: letter! });
        text.push(`Do not use the letter "${letter}" anywhere, in upper or lower case.`);
        break;
      case "includeWord": {
        const times = rng.int(2, 3);
        rules.push({ kind, word: include!, times });
        text.push(`Use the word "${include}" exactly ${times} times in total.`);
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
      case "lettersPerLine": {
        // About 4 to 5 letters a word, so it fits a word count too.
        const count = wordsPerLine ? rng.int(wordsPerLine * 4, wordsPerLine * 5) : rng.int(20, 30);
        rules.push({ kind, count });
        text.push(`Each line must contain exactly ${count} letters, not counting spaces or punctuation.`);
        break;
      }
      case "alliteration":
        rules.push({ kind });
        text.push("Within each line, every word must start with the same letter.");
        break;
      case "noRepeat":
        rules.push({ kind, ...(include ? { except: include } : {}) });
        text.push(`Never use the same word twice${include ? ` (except "${include}")` : ""}.`);
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
        const count = words(joined).filter((w) => w === rule.word).length;
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
      case "lettersPerLine": {
        const bad = lines.filter((l) => l.replace(/[^a-z]/gi, "").length !== rule.count).length;
        if (bad) failures.push(`${bad} lines with wrong letter count`);
        break;
      }
      case "alliteration": {
        const bad = lines.filter((l) => new Set(words(l).map((w) => w[0])).size > 1).length;
        if (bad) failures.push(`${bad} lines not alliterating`);
        break;
      }
      case "noRepeat": {
        const seen = new Set<string>();
        const repeated = new Set(words(joined).filter((w) => w !== rule.except && (seen.has(w) || !seen.add(w))));
        if (repeated.size) failures.push(`repeated ${[...repeated].map((w) => `"${w}"`).join(", ")}`);
        break;
      }
    }
  }

  return failures.length ? { passed: false, note: failures.join("; ") } : { passed: true };
}
