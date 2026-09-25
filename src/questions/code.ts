// Code: predict what a small generated Python program prints.
// We build the program as a tree, then both render it as Python and run it
// here, so the expected output never depends on executing anything.
// Difficulty = more variables, statements and loop iterations; from level 3 on, bigger numbers
// (a larger modulus) and variables multiplied together, so every step is harder arithmetic;
// from level 4, a list read and written at positions that depend on the variables' values.
import type { Rng } from "./rng.ts";
import type { Grade } from "./types.ts";

type Level = { vars: number; statements: number; loops: number[]; mod: number; multiply: boolean; list: number }; // list: its length, 0 for none
const LEVELS: Level[] = [
  { vars: 3, statements: 3, loops: [5], mod: 97, multiply: false, list: 0 },
  { vars: 3, statements: 4, loops: [8], mod: 97, multiply: false, list: 0 },
  { vars: 4, statements: 4, loops: [10], mod: 1009, multiply: true, list: 0 },
  { vars: 4, statements: 5, loops: [5, 4], mod: 10007, multiply: true, list: 6 },
  { vars: 4, statements: 6, loops: [6, 5], mod: 100003, multiply: true, list: 10 },
];
const VAR_NAMES = ["a", "b", "c", "d"];
const LOOP_NAMES = ["i", "j"];

type Index = { v: string; loop: string }; // xs[(v + loop) % length]
type Expr =
  | { op: "add"; x: string; y: string }
  | { op: "sub"; x: string; y: string }
  | { op: "mulAdd"; x: string; k: number; y: string }
  | { op: "mul"; x: string; y: string; k: number } // "+ k" so a 0 doesn't spread through every product
  | { op: "addLoop"; x: string; y: string; loop: string }
  | { op: "addItem"; x: string; at: Index };
type Assign = { kind: "assign"; target: string; expr: Expr };
type IfElse = { kind: "if"; v: string; loop: string; k: number; then: Assign; else: Assign };
type SetItem = { kind: "setItem"; at: Index; k: number; y: string }; // xs[at] = (xs[at] * k + y) % mod
type Statement = Assign | IfElse | SetItem;
type State = { vars: Record<string, number>; xs: number[] };

// Python's % always returns a non-negative result for a positive modulus.
const pmod = (n: number, mod: number) => ((n % mod) + mod) % mod;

function randomAssign(rng: Rng, vars: string[], loops: string[], config: Level): Assign {
  const x = rng.pick(vars);
  const y = rng.pick(vars);
  const other = rng.pick(vars.filter((v) => v !== x)); // "x - x" would always be 0
  const exprs: Expr[] = [
    { op: "add", x, y },
    { op: "sub", x, y: other },
    { op: "mulAdd", x, k: rng.int(2, 9), y },
    { op: "addLoop", x, y, loop: rng.pick(loops) },
  ];
  if (config.multiply) exprs.push({ op: "mul", x, y: other, k: rng.int(1, 9) });
  if (config.list) exprs.push({ op: "addItem", x, at: { v: rng.pick(vars), loop: rng.pick(loops) } });
  return { kind: "assign", target: rng.pick(vars), expr: rng.pick(exprs) };
}

function randomStatement(rng: Rng, vars: string[], loops: string[], config: Level): Statement {
  if (config.list && rng.int(1, 3) === 1) {
    return { kind: "setItem", at: { v: rng.pick(vars), loop: rng.pick(loops) }, k: rng.int(2, 9), y: rng.pick(vars) };
  }
  if (rng.int(1, 3) > 1) return randomAssign(rng, vars, loops, config);
  return {
    kind: "if",
    v: rng.pick(vars),
    loop: rng.pick(loops),
    k: rng.int(2, 5),
    then: randomAssign(rng, vars, loops, config),
    else: randomAssign(rng, vars, loops, config),
  };
}

const renderIndex = (at: Index, config: Level) => `xs[(${at.v} + ${at.loop}) % ${config.list}]`;

function renderExpr(e: Expr, config: Level): string {
  const { mod } = config;
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
    case "addItem":
      return `(${e.x} + ${renderIndex(e.at, config)}) % ${mod}`;
  }
}

function renderStatement(s: Statement, indent: string, config: Level): string[] {
  switch (s.kind) {
    case "assign":
      return [`${indent}${s.target} = ${renderExpr(s.expr, config)}`];
    case "setItem": {
      const item = renderIndex(s.at, config);
      return [`${indent}${item} = (${item} * ${s.k} + ${s.y}) % ${config.mod}`];
    }
    case "if":
      return [
        `${indent}if (${s.v} + ${s.loop}) % ${s.k} == 0:`,
        ...renderStatement(s.then, indent + "    ", config),
        `${indent}else:`,
        ...renderStatement(s.else, indent + "    ", config),
      ];
  }
}

const position = (at: Index, state: State, config: Level) => (state.vars[at.v] + state.vars[at.loop]) % config.list;

// Values stay below mod, so every product stays far below 2^53, where JavaScript numbers stop being exact.
function evalExpr(e: Expr, state: State, config: Level): number {
  const v = state.vars;
  const { mod } = config;
  switch (e.op) {
    case "add":
      return pmod(v[e.x] + v[e.y], mod);
    case "sub":
      return pmod(v[e.x] - v[e.y], mod);
    case "mulAdd":
      return pmod(v[e.x] * e.k + v[e.y], mod);
    case "mul":
      return pmod(v[e.x] * v[e.y] + e.k, mod);
    case "addLoop":
      return pmod(v[e.x] + v[e.y] * v[e.loop], mod);
    case "addItem":
      return pmod(v[e.x] + state.xs[position(e.at, state, config)], mod);
  }
}

function runStatement(s: Statement, state: State, config: Level) {
  switch (s.kind) {
    case "assign":
      state.vars[s.target] = evalExpr(s.expr, state, config);
      break;
    case "setItem": {
      const p = position(s.at, state, config);
      state.xs[p] = pmod(state.xs[p] * s.k + state.vars[s.y], config.mod);
      break;
    }
    case "if":
      runStatement((state.vars[s.v] + state.vars[s.loop]) % s.k === 0 ? s.then : s.else, state, config);
      break;
  }
}

export function generateCode(rng: Rng, level: number): { prompt: string; expected: string; program: string } {
  const config = LEVELS[level - 1];
  const vars = VAR_NAMES.slice(0, config.vars);
  const loops = LOOP_NAMES.slice(0, config.loops.length);
  const init = vars.map(() => rng.int(0, 20));
  const initList = Array.from({ length: config.list }, () => rng.int(0, 20));
  const body = Array.from({ length: config.statements }, () => randomStatement(rng, vars, loops, config));

  // Render
  const lines = vars.map((v, k) => `${v} = ${init[k]}`);
  if (config.list) lines.push(`xs = [${initList.join(", ")}]`);
  config.loops.forEach((count, depth) => {
    lines.push(`${"    ".repeat(depth)}for ${loops[depth]} in range(${count}):`);
  });
  const bodyIndent = "    ".repeat(config.loops.length);
  for (const s of body) lines.push(...renderStatement(s, bodyIndent, config));
  lines.push(`print(${vars.join(", ")}${config.list ? ", *xs" : ""})`);
  const program = lines.join("\n");

  // Run
  const state: State = { vars: Object.fromEntries(vars.map((v, k) => [v, init[k]])), xs: [...initList] };
  const loop = (depth: number) => {
    if (depth === config.loops.length) {
      for (const s of body) runStatement(s, state, config);
      return;
    }
    for (let n = 0; n < config.loops[depth]; n++) {
      state.vars[loops[depth]] = n;
      loop(depth + 1);
    }
  };
  loop(0);
  const expected = [...vars.map((v) => state.vars[v]), ...state.xs].join(" ");

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
