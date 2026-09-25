// Reasoning: track a list through a long sequence of operations.
// Difficulty = more operations, and from level 2 on, operations that depend on the list's values
// (its largest element, its sum, whether it contains a number), so every earlier mistake carries forward.
import type { Rng } from "./rng.ts";
import type { Grade } from "./types.ts";

const BASIC = ["append", "prepend", "removeFirst", "removeLast", "reverse", "rotate", "swap", "add"] as const;
const BY_VALUE = ["removeMax", "minToFront", "subtract", "appendCount"] as const;
const CONDITIONAL = ["ifEvenSum", "ifFirstGreater", "ifContains"] as const;
type Kind = (typeof BASIC)[number] | (typeof BY_VALUE)[number] | (typeof CONDITIONAL)[number];

type Level = { steps: number; kinds: readonly Kind[] };
const LEVELS: Level[] = [
  { steps: 12, kinds: BASIC },
  { steps: 25, kinds: [...BASIC, ...BY_VALUE] },
  { steps: 40, kinds: [...BASIC, ...BY_VALUE, ...CONDITIONAL] },
  { steps: 60, kinds: [...BASIC, ...BY_VALUE, ...CONDITIONAL] },
  { steps: 90, kinds: [...BASIC, ...BY_VALUE, ...CONDITIONAL] },
];
const START_LENGTH = 6;
const MIN_LENGTH = 3;
const MAX_LENGTH = 10;

const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);

export function generateReasoning(rng: Rng, level: number): { prompt: string; expected: number[] } {
  const { steps, kinds } = LEVELS[level - 1];
  const start = Array.from({ length: START_LENGTH }, () => rng.int(1, 9));
  const list = [...start];
  const ops: string[] = [];
  const canGrow = () => list.length < MAX_LENGTH;
  const canShrink = () => list.length > MIN_LENGTH;

  while (ops.length < steps) {
    switch (rng.pick(kinds)) {
      case "append": {
        if (!canGrow()) continue;
        const n = rng.int(1, 20);
        list.push(n);
        ops.push(`Append ${n} to the end.`);
        break;
      }
      case "prepend": {
        if (!canGrow()) continue;
        const n = rng.int(1, 20);
        list.unshift(n);
        ops.push(`Insert ${n} at the start.`);
        break;
      }
      case "removeFirst":
        if (!canShrink()) continue;
        list.shift();
        ops.push("Remove the first element.");
        break;
      case "removeLast":
        if (!canShrink()) continue;
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
      case "removeMax":
        if (!canShrink()) continue;
        list.splice(list.indexOf(Math.max(...list)), 1);
        ops.push("Remove the largest element (if there's a tie, the first one).");
        break;
      case "minToFront":
        list.unshift(...list.splice(list.indexOf(Math.min(...list)), 1));
        ops.push("Move the smallest element to the start (if there's a tie, the first one).");
        break;
      case "subtract": {
        const i = rng.int(1, list.length);
        const j = rng.int(1, list.length);
        if (i === j) continue;
        list[i - 1] -= list[j - 1];
        ops.push(`Subtract the element at position ${j} from the element at position ${i}.`);
        break;
      }
      case "appendCount": {
        if (!canGrow()) continue;
        const n = rng.int(3, 12);
        list.push(list.filter((v) => v > n).length);
        ops.push(`Append the number of elements greater than ${n}.`);
        break;
      }
      case "ifEvenSum":
        if (!canShrink()) continue;
        if (sum(list) % 2 === 0) list.reverse();
        else list.pop();
        ops.push("If the sum of all elements is even, reverse the list; otherwise remove the last element.");
        break;
      case "ifFirstGreater":
        if (list[0] > list.at(-1)!) [list[0], list[list.length - 1]] = [list.at(-1)!, list[0]];
        else list.unshift(list.pop()!);
        ops.push("If the first element is greater than the last, swap them; otherwise move the last element to the start.");
        break;
      case "ifContains": {
        if (!canGrow() || !canShrink()) continue;
        const n = rng.int(1, 12);
        if (list.includes(n)) list.splice(list.indexOf(n), 1);
        else list.push(n);
        ops.push(`If the list contains ${n}, remove its first occurrence; otherwise append ${n}.`);
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
