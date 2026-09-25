// Code: predict what a small generated Python program prints.
// We build the program as a tree, then both render it as Python and run it
// here, so the expected output never depends on executing anything.
// Difficulty = more variables, statements and loop iterations.
import type { Rng } from "./rng.ts";
import type { Grade } from "./types.ts";

const MOD = 97;

type Level = { vars: number; statements: number; loops: number[] };
const LEVELS: Level[] = [
  { vars: 3, statements: 2, loops: [4] },
  { vars: 3, statements: 3, loops: [6] },
  { vars: 3, statements: 4, loops: [10] },
  { vars: 4, statements: 5, loops: [15] },
  { vars: 4, statements: 4, loops: [6, 5] },
];
const VAR_NAMES = ["a", "b", "c", "d"];
const LOOP_NAMES = ["i", "j"];

type Expr =
  | { op: "add"; x: string; y: string }
  | { op: "sub"; x: string; y: string }
  | { op: "mulAdd"; x: string; k: number; y: string }
  | { op: "addLoop"; x: string; y: string; loop: string };
type Assign = { kind: "assign"; target: string; expr: Expr };
type IfElse = { kind: "if"; v: string; loop: string; k: number; then: Assign; else: Assign };
type Statement = Assign | IfElse;
type Env = Record<string, number>;

// Python's % always returns a non-negative result for a positive modulus.
const pmod = (n: number) => ((n % MOD) + MOD) % MOD;

function randomAssign(rng: Rng, vars: string[], loops: string[]): Assign {
  const x = rng.pick(vars);
  const y = rng.pick(vars);
  const other = rng.pick(vars.filter((v) => v !== x)); // "x - x" would always be 0
  const expr: Expr = rng.pick([
    { op: "add", x, y },
    { op: "sub", x, y: other },
    { op: "mulAdd", x, k: rng.int(2, 5), y },
    { op: "addLoop", x, y, loop: rng.pick(loops) },
  ] as Expr[]);
  return { kind: "assign", target: rng.pick(vars), expr };
}

function randomStatement(rng: Rng, vars: string[], loops: string[]): Statement {
  if (rng.int(1, 3) > 1) return randomAssign(rng, vars, loops);
  return {
    kind: "if",
    v: rng.pick(vars),
    loop: rng.pick(loops),
    k: rng.int(2, 5),
    then: randomAssign(rng, vars, loops),
    else: randomAssign(rng, vars, loops),
  };
}

function renderExpr(e: Expr): string {
  switch (e.op) {
    case "add":
      return `(${e.x} + ${e.y}) % ${MOD}`;
    case "sub":
      return `(${e.x} - ${e.y}) % ${MOD}`;
    case "mulAdd":
      return `(${e.x} * ${e.k} + ${e.y}) % ${MOD}`;
    case "addLoop":
      return `(${e.x} + ${e.y} * ${e.loop}) % ${MOD}`;
  }
}

function renderStatement(s: Statement, indent: string): string[] {
  if (s.kind === "assign") return [`${indent}${s.target} = ${renderExpr(s.expr)}`];
  return [
    `${indent}if (${s.v} + ${s.loop}) % ${s.k} == 0:`,
    ...renderStatement(s.then, indent + "    "),
    `${indent}else:`,
    ...renderStatement(s.else, indent + "    "),
  ];
}

function evalExpr(e: Expr, env: Env): number {
  switch (e.op) {
    case "add":
      return pmod(env[e.x] + env[e.y]);
    case "sub":
      return pmod(env[e.x] - env[e.y]);
    case "mulAdd":
      return pmod(env[e.x] * e.k + env[e.y]);
    case "addLoop":
      return pmod(env[e.x] + env[e.y] * env[e.loop]);
  }
}

function runStatement(s: Statement, env: Env) {
  if (s.kind === "assign") {
    env[s.target] = evalExpr(s.expr, env);
  } else {
    runStatement((env[s.v] + env[s.loop]) % s.k === 0 ? s.then : s.else, env);
  }
}

export function generateCode(rng: Rng, level: number): { prompt: string; expected: string; program: string } {
  const config = LEVELS[level - 1];
  const vars = VAR_NAMES.slice(0, config.vars);
  const loops = LOOP_NAMES.slice(0, config.loops.length);
  const init = vars.map(() => rng.int(0, 20));
  const body = Array.from({ length: config.statements }, () => randomStatement(rng, vars, loops));

  // Render
  const lines = vars.map((v, k) => `${v} = ${init[k]}`);
  config.loops.forEach((count, depth) => {
    lines.push(`${"    ".repeat(depth)}for ${loops[depth]} in range(${count}):`);
  });
  const bodyIndent = "    ".repeat(config.loops.length);
  for (const s of body) lines.push(...renderStatement(s, bodyIndent));
  lines.push(`print(${vars.join(", ")})`);
  const program = lines.join("\n");

  // Run
  const env: Env = Object.fromEntries(vars.map((v, k) => [v, init[k]]));
  const loop = (depth: number) => {
    if (depth === config.loops.length) {
      for (const s of body) runStatement(s, env);
      return;
    }
    for (let n = 0; n < config.loops[depth]; n++) {
      env[loops[depth]] = n;
      loop(depth + 1);
    }
  };
  loop(0);
  const expected = vars.map((v) => env[v]).join(" ");

  const prompt = [
    "What does this Python program print?",
    "",
    "```python",
    program,
    "```",
    "",
    "Work it out without running it. Write the exact output on the last line, and nothing else on that line.",
  ].join("\n");

  return { prompt, expected, program };
}

export function gradeCode(text: string, expected: string): Grade {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/`/g, "").trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? "";
  const got = last.match(/-?\d+/g)?.join(" ") ?? "";
  return got === expected ? { passed: true } : { passed: false, note: `got "${last}"` };
}
