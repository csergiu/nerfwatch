// Logic: knights-and-knaves puzzles. Knights only say true things, knaves only false ones;
// work out who is which from what they say. Each puzzle is checked against every possible answer,
// so exactly one fits, and trimmed so every statement is needed to find it.
// Difficulty = more people, and statements that tie more of them together.
import type { Rng } from "./rng.ts";
import type { Grade } from "./types.ts";

type Statement = { speaker: number } & (
  | { kind: "is"; who: number; knight: boolean }
  | { kind: "same"; a: number; b: number; same: boolean }
  | { kind: "or"; a: number; b: number } // at least one of them is a knight
  | { kind: "if"; a: number; b: number; knight: boolean } // if a is a knight, then b is a knight (or a knave)
  | { kind: "count"; group: number[]; k: number; knights: boolean } // exactly k of the group are knights (or knaves)
  | { kind: "countAll"; k: number } // exactly k of everyone are knights
);
type Kind = Statement["kind"];

type Level = { people: number; kinds: Kind[] };
const LEVELS: Level[] = [
  { people: 4, kinds: ["is", "same"] },
  { people: 5, kinds: ["is", "same", "or"] },
  { people: 7, kinds: ["is", "same", "or", "if", "count"] },
  { people: 9, kinds: ["same", "or", "if", "count", "countAll"] },
  { people: 11, kinds: ["same", "or", "if", "count", "countAll"] },
];

const NAMES = [
  "Ada", "Ben", "Cleo", "Dev", "Eli", "Faye", "Gus", "Hana", "Ivo", "Jun",
  "Kit", "Lior", "Mae", "Nils", "Otto", "Pia", "Rhea", "Sol", "Tess", "Uma",
];

function holds(s: Statement, knight: boolean[]): boolean {
  switch (s.kind) {
    case "is":
      return knight[s.who] === s.knight;
    case "same":
      return (knight[s.a] === knight[s.b]) === s.same;
    case "or":
      return knight[s.a] || knight[s.b];
    case "if":
      return !knight[s.a] || knight[s.b] === s.knight;
    case "count":
      return s.group.filter((p) => knight[p] === s.knights).length === s.k;
    case "countAll":
      return knight.filter(Boolean).length === s.k;
  }
}

// Every assignment of knights and knaves that fits the statements, stopping at `limit`.
function solutions(people: number, statements: Statement[], limit = 2): boolean[][] {
  const found: boolean[][] = [];
  for (let mask = 0; mask < 1 << people && found.length < limit; mask++) {
    const knight = Array.from({ length: people }, (_, p) => ((mask >> p) & 1) === 1);
    if (statements.every((s) => holds(s, knight) === knight[s.speaker])) found.push(knight);
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
      return { speaker, kind, group, k: rng.int(1, group.length - 1), knights: rng.int(0, 1) === 1 };
    }
    case "countAll":
      return { speaker, kind, k: rng.int(1, people - 1) };
  }
}

const list = (names: string[]) => `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

function render(s: Statement, names: string[], people: number): string {
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
    case "countAll":
      return `Exactly ${s.k} of the ${people} of us ${s.k === 1 ? "is a knight" : "are knights"}.`;
  }
}

export function generateLogic(rng: Rng, level: number): { prompt: string; expected: string[] } {
  const { people, kinds } = LEVELS[level - 1];
  const names = rng.shuffle(NAMES).slice(0, people);
  let knight: boolean[] = [];
  let statements: Statement[] = [];

  // A statement the speaker would really make: true for a knight, false for a knave.
  const truthful = (speaker: number) => {
    let s: Statement;
    do s = randomStatement(rng, kinds, speaker, people);
    while (holds(s, knight) !== knight[speaker]);
    return s;
  };

  // Everyone speaks once; then more statements until only one answer fits.
  // Starts over in the rare case the statements keep missing the difference between two answers.
  while (!statements.length || solutions(people, statements).length > 1) {
    do knight = names.map(() => rng.int(0, 1) === 1);
    while (knight.every(Boolean) || !knight.some(Boolean));
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
    const said = statements.filter((s) => s.speaker === p).map((s) => render(s, names, people));
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

  return { prompt, expected: names.filter((_, p) => knight[p]).sort() };
}

// The names on the last line, compared as a set.
export function gradeLogic(text: string, expected: string[], names: readonly string[] = NAMES): Grade {
  const last = text.trim().split("\n").at(-1) ?? "";
  const got = names.filter((n) => new RegExp(`\\b${n}\\b`, "i").test(last)).sort();
  const passed = got.length === expected.length && got.every((n, k) => n === expected[k]);
  return passed ? { passed } : { passed, note: `got ${got.join(", ") || "no names"}` };
}
