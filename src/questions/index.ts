import { generateCode, gradeCode } from "./code.ts";
import { generateInstructions, gradeInstructions } from "./instructions.ts";
import { generateDirectory, generateLongContextQuestion, gradeLongContext } from "./longContext.ts";
import { generateReasoning, gradeReasoning } from "./reasoning.ts";
import { createRng } from "./rng.ts";
import type { Category, Grade, Question, QuestionSet } from "./types.ts";

export type { Category, Grade, Question, QuestionSet } from "./types.ts";

export const CATEGORIES: Category[] = ["reasoning", "code", "instructions", "long-context"];
export const LEVELS = [1, 2, 3, 4, 5];
const PER_LEVEL = 5; // 4 categories x 5 levels x 5 = 100 questions

// The live probe: 10 mid-difficulty questions, only one of them long-context to keep it cheap.
const PROBE_IDS = new Set([
  "reasoning-L2-1", "reasoning-L3-1", "reasoning-L4-1",
  "code-L2-1", "code-L3-1", "code-L4-1",
  "instructions-L2-1", "instructions-L3-1", "instructions-L4-1",
  "long-context-L1-1",
]);

export function generateQuestionSet(seed: number): QuestionSet {
  const documents: Record<string, string> = {};
  const questions: Question[] = [];

  CATEGORIES.forEach((category, c) => {
    // One stream of random numbers per category, so changing one generator leaves the others alone.
    const rng = createRng(seed * 31 + c);

    for (const level of LEVELS) {
      const directory = category === "long-context" ? generateDirectory(rng, level) : undefined;
      const documentId = directory ? `directory-L${level}` : undefined;
      if (directory && documentId) documents[documentId] = directory.text;
      const usedStarts = new Set<number>();

      for (let n = 1; n <= PER_LEVEL; n++) {
        const id = `${category}-L${level}-${n}`;
        const base = { id, level, probe: PROBE_IDS.has(id) };
        switch (category) {
          case "reasoning":
            questions.push({ ...base, category, ...generateReasoning(rng, level) });
            break;
          case "code": {
            const { prompt, expected } = generateCode(rng, level);
            questions.push({ ...base, category, prompt, expected });
            break;
          }
          case "instructions":
            questions.push({ ...base, category, ...generateInstructions(rng, level) });
            break;
          case "long-context":
            questions.push({
              ...base,
              category,
              documentId,
              ...generateLongContextQuestion(rng, level, directory!.records, usedStarts),
            });
            break;
        }
      }
    }
  });

  return { seed, createdAt: new Date().toISOString(), documents, questions };
}

export function grade(question: Question, text: string): Grade {
  switch (question.category) {
    case "reasoning":
      return gradeReasoning(text, question.expected);
    case "code":
      return gradeCode(text, question.expected);
    case "instructions":
      return gradeInstructions(text, question.expected);
    case "long-context":
      return gradeLongContext(text, question.expected);
  }
}
