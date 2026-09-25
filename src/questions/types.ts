import type { InstructionSpec } from "./instructions.ts";

export type Category = "reasoning" | "logic" | "code" | "instructions" | "long-context";

type Base = {
  id: string; // e.g. "code-L3-2"
  level: number; // 1 (easiest) to 5
  prompt: string;
  probe: boolean; // also part of the small live probe
  documentId?: string; // long-context only: shared document sent before the prompt
};

export type Question = Base &
  (
    | { category: "reasoning"; expected: number[] }
    | { category: "logic"; expected: string[] } // the knights' names
    | { category: "code"; expected: string }
    | { category: "instructions"; expected: InstructionSpec }
    | { category: "long-context"; expected: string }
  );

export type QuestionSet = {
  seed: number;
  createdAt: string;
  documents: Record<string, string>;
  questions: Question[];
};

export type Grade = { passed: boolean; note?: string };
