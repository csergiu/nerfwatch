// Logic: knights-and-knaves puzzles. Knights only say true things, knaves only false ones;
// work out who is which from what they say. Each puzzle is checked against every possible answer,
// so exactly one fits, and trimmed so every statement is needed to find it.
// Difficulty = more people, and from level 4, only statements that tie several of them together
// (nobody says outright who is a knight), so every answer takes a chain of deductions.
import type { Rng } from "./rng.ts";
import type { Grade } from "./types.ts";

type Statement = { speaker: number } & (
  | { kind: "is"; who: number; knight: boolean }
  | { kind: "same"; a: number; b: number; same: boolean }
  | { kind: "or"; a: number; b: number } // at least one of them is a knight
  | { kind: "if"; a: number; b: number; knight: boolean } // if a is a knight, then b is a knight (or a knave)
  | { kind: "count"; group: number[]; mask: number; k: number; knights: boolean } // exactly k of the group are knights (or knaves)
  | { kind: "atLeast"; group: number[]; mask: number; k: number } // at least k of the group are knights
);
type Kind = Statement["kind"];

type Level = { people: number; kinds: Kind[] };
const LEVELS: Level[] = [
  { people: 4, kinds: ["is", "same"] },
  { people: 5, kinds: ["is", "same", "or"] },
  { people: 9, kinds: ["is", "same", "or", "if", "count"] },
  { people: 12, kinds: ["same", "or", "if", "count", "atLeast"] },
  { people: 16, kinds: ["same", "or", "if", "count", "atLeast"] },
];

const NAMES = [
  "Ada", "Ben", "Cleo", "Dev", "Eli", "Faye", "Gus", "Hana", "Ivo", "Jun",
  "Kit", "Lior", "Mae", "Nils", "Otto", "Pia", "Rhea", "Sol", "Tess", "Uma",
];

// Who is a knight, as bits: bit p is set when person p is a knight. Checking every possible answer
// means trying up to 2^16 of these, so they stay plain numbers.
type Knights = number;
const isKnight = (knights: Knights, p: number) => ((knights >> p) & 1) === 1;
const countBits = (n: number) => {
  let c = 0;
  for (; n; n &= n - 1) c++;
  return c;
};
const maskOf = (group: number[]) => group.reduce((m, p) => m | (1 << p), 0);

function holds(s: Statement, knights: Knights): boolean {
  switch (s.kind) {
    case "is":
      return isKnight(knights, s.who) === s.knight;
    case "same":
      return (isKnight(knights, s.a) === isKnight(knights, s.b)) === s.same;
    case "or":
      return isKnight(knights, s.a) || isKnight(knights, s.b);
    case "if":
      return !isKnight(knights, s.a) || isKnight(knights, s.b) === s.knight;
    case "count": {
      const inGroup = countBits(knights & s.mask);
      return (s.knights ? inGroup : s.group.length - inGroup) === s.k;
    }
    case "atLeast":
      return countBits(knights & s.mask) >= s.k;
  }
}

// Every assignment of knights and knaves that fits the statements, stopping at `limit`.
function solutions(people: number, statements: Statement[], limit = 2): Knights[] {
  const found: Knights[] = [];
  for (let knights = 0; knights < 1 << people && found.length < limit; knights++) {
    if (statements.every((s) => holds(s, knights) === isKnight(knights, s.speaker))) found.push(knights);
  }
  return found;
}

function randomStatement(rng: Rng, kinds: Kind[], speaker: number, people: number): Statement {
  const others = Array.from({ length: people }, (_, p) => p).filter((p) => p !== speaker);
  const [a, b] = rng.shuffle(others);
  const kind = rng.pick(kinds);
  switch (kind) {
    case "is":
      return { speaker, kind, who: a, knight: rng.int(0, 1) === 1 };
    case "same":
      return { speaker, kind, a, b, same: rng.int(0, 1) === 1 };
    case "or":
      return { speaker, kind, a, b };
    case "if":
      return { speaker, kind, a, b, knight: rng.int(0, 1) === 1 };
    case "count": {
      const group = rng.shuffle(others).slice(0, rng.int(3, 4)).sort((x, y) => x - y);
      return { speaker, kind, group, mask: maskOf(group), k: rng.int(1, group.length - 1), knights: rng.int(0, 1) === 1 };
    }
    case "atLeast": {
      const group = rng.shuffle(others).slice(0, rng.int(4, 5)).sort((x, y) => x - y);
      return { speaker, kind, group, mask: maskOf(group), k: rng.int(2, group.length - 1) };
    }
  }
}

const list = (names: string[]) => `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

function render(s: Statement, names: string[]): string {
  const kind = (knight: boolean) => (knight ? "a knight" : "a knave");
  switch (s.kind) {
    case "is":
      return `${names[s.who]} is ${kind(s.knight)}.`;
    case "same":
      return `${names[s.a]} and ${names[s.b]} are ${s.same ? "the same kind" : "different kinds"}.`;
    case "or":
      return `At least one of ${names[s.a]} and ${names[s.b]} is a knight.`;
    case "if":
      return `If ${names[s.a]} is a knight, then ${names[s.b]} is ${kind(s.knight)}.`;
    case "count": {
      const what = s.knights ? (s.k === 1 ? "is a knight" : "are knights") : s.k === 1 ? "is a knave" : "are knaves";
      return `Exactly ${s.k} of ${list(s.group.map((p) => names[p]))} ${what}.`;
    }
    case "atLeast":
      return `At least ${s.k} of ${list(s.group.map((p) => names[p]))} are knights.`;
  }
}

export function generateLogic(rng: Rng, level: number): { prompt: string; expected: string[] } {
  const { people, kinds } = LEVELS[level - 1];
  const names = rng.shuffle(NAMES).slice(0, people);
  const everyone = (1 << people) - 1;
  let knights: Knights = 0;
  let statements: Statement[] = [];

  // A statement the speaker would really make: true for a knight, false for a knave.
  const truthful = (speaker: number) => {
    let s: Statement;
    do s = randomStatement(rng, kinds, speaker, people);
    while (holds(s, knights) !== isKnight(knights, speaker));
    return s;
  };

  // Everyone speaks once; then more statements until only one answer fits.
  // Starts over in the rare case the statements keep missing the difference between two answers.
  while (!statements.length || solutions(people, statements).length > 1) {
    do knights = names.reduce((m, _, p) => (rng.int(0, 1) === 1 ? m | (1 << p) : m), 0);
    while (knights === 0 || knights === everyone);
    statements = names.map((_, p) => truthful(p));
    while (statements.length < people * 4 && solutions(people, statements).length > 1) {
      statements.push(truthful(rng.int(0, people - 1)));
    }
  }

  // Drop every statement the puzzle can be solved without.
  for (const s of rng.shuffle(statements)) {
    const without = statements.filter((x) => x !== s);
    if (solutions(people, without).length === 1) statements = without;
  }

  const lines = names.flatMap((name, p) => {
    const said = statements.filter((s) => s.speaker === p).map((s) => render(s, names));
    return said.length ? [`${name} says: "${said.join(" ")}"`] : [];
  });
  const prompt = [
    "On an island, everyone is either a knight or a knave. Every sentence a knight says is true, and every sentence a knave says is false.",
    `You meet ${people} people: ${list(names)}.`,
    "",
    ...lines,
    "",
    "Who are the knights? Write their names on the last line, separated by commas.",
  ].join("\n");

  return { prompt, expected: names.filter((_, p) => isKnight(knights, p)).sort() };
}

// The names on the last line, compared as a set.
export function gradeLogic(text: string, expected: string[], names: readonly string[] = NAMES): Grade {
  const last = text.trim().split("\n").at(-1) ?? "";
  const got = names.filter((n) => new RegExp(`\\b${n}\\b`, "i").test(last)).sort();
  const passed = got.length === expected.length && got.every((n, k) => n === expected[k]);
  return passed ? { passed } : { passed, note: `got ${got.join(", ") || "no names"}` };
}
