// Code: predict what a small generated Python program prints.
// We build the program as a tree, then both render it as Python and run it
// here, so the expected output never depends on executing anything.
// Difficulty = more variables, statements and loop iterations, and from level 3 on, bigger numbers
// (a larger modulus) and variables multiplied together, so every step is harder arithmetic.
import type { Rng } from "./rng.ts";
import type { Grade } from "./types.ts";

type Level = { vars: number; statements: number; loops: number[]; mod: number; multiply: boolean };
const LEVELS: Level[] = [
  { vars: 3, statements: 3, loops: [5], mod: 97, multiply: false },
  { vars: 3, statements: 4, loops: [8], mod: 97, multiply: false },
  { vars: 4, statements: 4, loops: [10], mod: 1009, multiply: true },
  { vars: 4, statements: 5, loops: [4, 4], mod: 10007, multiply: true },
  { vars: 4, statements: 5, loops: [4, 4], mod: 100003, multiply: true },
];
const VAR_NAMES = ["a", "b", "c", "d"];
const LOOP_NAMES = ["i", "j"];

type Expr =
  | { op: "add"; x: string; y: string }
  | { op: "sub"; x: string; y: string }
  | { op: "mulAdd"; x: string; k: number; y: string }
  | { op: "mul"; x: string; y: string; k: number } // "+ k" so a 0 doesn't spread through every product
  | { op: "addLoop"; x: string; y: string; loop: string };
type Assign = { kind: "assign"; target: string; expr: Expr };
type IfElse = { kind: "if"; v: string; loop: string; k: number; then: Assign; else: Assign };
type Statement = Assign | IfElse;
type Env = Record<string, number>;

// Python's % always returns a non-negative result for a positive modulus.
const pmod = (n: number, mod: number) => ((n % mod) + mod) % mod;

function randomAssign(rng: Rng, vars: string[], loops: string[], multiply: boolean): Assign {
  const x = rng.pick(vars);
  const y = rng.pick(vars);
  const other = rng.pick(vars.filter((v) => v !== x)); // "x - x" would always be 0
  const exprs: Expr[] = [
    { op: "add", x, y },
    { op: "sub", x, y: other },
    { op: "mulAdd", x, k: rng.int(2, 9), y },
    { op: "addLoop", x, y, loop: rng.pick(loops) },
  ];
  if (multiply) exprs.push({ op: "mul", x, y: other, k: rng.int(1, 9) });
  return { kind: "assign", target: rng.pick(vars), expr: rng.pick(exprs) };
}

function randomStatement(rng: Rng, vars: string[], loops: string[], multiply: boolean): Statement {
  if (rng.int(1, 3) > 1) return randomAssign(rng, vars, loops, multiply);
  return {
    kind: "if",
    v: rng.pick(vars),
    loop: rng.pick(loops),
    k: rng.int(2, 5),
    then: randomAssign(rng, vars, loops, multiply),
    else: randomAssign(rng, vars, loops, multiply),
  };
}

function renderExpr(e: Expr, mod: number): string {
  switch (e.op) {
    case "add":
      return `(${e.x} + ${e.y}) % ${mod}`;
    case "sub":
      return `(${e.x} - ${e.y}) % ${mod}`;
    case "mulAdd":
      return `(${e.x} * ${e.k} + ${e.y}) % ${mod}`;
    case "mul":
      return `(${e.x} * ${e.y} + ${e.k}) % ${mod}`;
    case "addLoop":
      return `(${e.x} + ${e.y} * ${e.loop}) % ${mod}`;
  }
}

function renderStatement(s: Statement, indent: string, mod: number): string[] {
  if (s.kind === "assign") return [`${indent}${s.target} = ${renderExpr(s.expr, mod)}`];
  return [
    `${indent}if (${s.v} + ${s.loop}) % ${s.k} == 0:`,
    ...renderStatement(s.then, indent + "    ", mod),
    `${indent}else:`,
    ...renderStatement(s.else, indent + "    ", mod),
  ];
}

// Values stay below mod, so every product stays far below 2^53, where JavaScript numbers stop being exact.
function evalExpr(e: Expr, env: Env, mod: number): number {
  switch (e.op) {
    case "add":
      return pmod(env[e.x] + env[e.y], mod);
    case "sub":
      return pmod(env[e.x] - env[e.y], mod);
    case "mulAdd":
      return pmod(env[e.x] * e.k + env[e.y], mod);
    case "mul":
      return pmod(env[e.x] * env[e.y] + e.k, mod);
    case "addLoop":
      return pmod(env[e.x] + env[e.y] * env[e.loop], mod);
  }
}

function runStatement(s: Statement, env: Env, mod: number) {
  if (s.kind === "assign") {
    env[s.target] = evalExpr(s.expr, env, mod);
  } else {
    runStatement((env[s.v] + env[s.loop]) % s.k === 0 ? s.then : s.else, env, mod);
  }
}

export function generateCode(rng: Rng, level: number): { prompt: string; expected: string; program: string } {
  const config = LEVELS[level - 1];
  const vars = VAR_NAMES.slice(0, config.vars);
  const loops = LOOP_NAMES.slice(0, config.loops.length);
  const init = vars.map(() => rng.int(0, 20));
  const body = Array.from({ length: config.statements }, () => randomStatement(rng, vars, loops, config.multiply));

  // Render
  const lines = vars.map((v, k) => `${v} = ${init[k]}`);
  config.loops.forEach((count, depth) => {
    lines.push(`${"    ".repeat(depth)}for ${loops[depth]} in range(${count}):`);
  });
  const bodyIndent = "    ".repeat(config.loops.length);
  for (const s of body) lines.push(...renderStatement(s, bodyIndent, config.mod));
  lines.push(`print(${vars.join(", ")})`);
  const program = lines.join("\n");

  // Run
  const env: Env = Object.fromEntries(vars.map((v, k) => [v, init[k]]));
  const loop = (depth: number) => {
    if (depth === config.loops.length) {
      for (const s of body) runStatement(s, env, config.mod);
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
