// Reasoning: track a list through a long sequence of operations.
// Difficulty = number of operations.
import type { Rng } from "./rng.ts";
import type { Grade } from "./types.ts";

const STEPS_BY_LEVEL = [8, 16, 32, 48, 64];
const MIN_LENGTH = 3;
const MAX_LENGTH = 9;

const KINDS = ["append", "prepend", "removeFirst", "removeLast", "reverse", "rotate", "swap", "add"] as const;

export function generateReasoning(rng: Rng, level: number): { prompt: string; expected: number[] } {
  const start = Array.from({ length: 5 }, () => rng.int(1, 9));
  const list = [...start];
  const ops: string[] = [];

  while (ops.length < STEPS_BY_LEVEL[level - 1]) {
    switch (rng.pick(KINDS)) {
      case "append": {
        if (list.length >= MAX_LENGTH) continue;
        const n = rng.int(1, 20);
        list.push(n);
        ops.push(`Append ${n} to the end.`);
        break;
      }
      case "prepend": {
        if (list.length >= MAX_LENGTH) continue;
        const n = rng.int(1, 20);
        list.unshift(n);
        ops.push(`Insert ${n} at the start.`);
        break;
      }
      case "removeFirst":
        if (list.length <= MIN_LENGTH) continue;
        list.shift();
        ops.push("Remove the first element.");
        break;
      case "removeLast":
        if (list.length <= MIN_LENGTH) continue;
        list.pop();
        ops.push("Remove the last element.");
        break;
      case "reverse":
        list.reverse();
        ops.push("Reverse the list.");
        break;
      case "rotate":
        list.push(list.shift()!);
        ops.push("Move the first element to the end.");
        break;
      case "swap": {
        const i = rng.int(1, list.length);
        const j = rng.int(1, list.length);
        if (i === j) continue;
        [list[i - 1], list[j - 1]] = [list[j - 1], list[i - 1]];
        ops.push(`Swap the elements at positions ${i} and ${j}.`);
        break;
      }
      case "add": {
        const i = rng.int(1, list.length);
        const n = rng.int(1, 9);
        list[i - 1] += n;
        ops.push(`Add ${n} to the element at position ${i}.`);
        break;
      }
    }
  }

  const prompt = [
    `Start with this list: [${start.join(", ")}]`,
    "Apply the following operations in order. Positions are counted from 1.",
    "",
    ...ops.map((op, k) => `${k + 1}. ${op}`),
    "",
    "What is the final list? Write the final list on the last line, in the form [a, b, c].",
  ].join("\n");

  return { prompt, expected: list };
}

export function gradeReasoning(text: string, expected: number[]): Grade {
  const lists = [...text.matchAll(/\[([^[\]]*)\]/g)];
  if (lists.length === 0) return { passed: false, note: "no list found" };

  const values = lists.at(-1)![1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const passed = values.length === expected.length && values.every((v, i) => v === expected[i]);
  return passed ? { passed } : { passed, note: `got [${values.join(", ")}]` };
}
