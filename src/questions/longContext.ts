// Long context: follow a chain of references through a large staff directory.
// Difficulty = directory size (roughly 2k to 40k tokens).
// All questions at one level share the same document, so it can be cached.
import type { Rng } from "./rng.ts";
import type { Grade } from "./types.ts";

const RECORDS_BY_LEVEL = [60, 150, 300, 600, 1200];

const FIRST_NAMES = [
  "Maren", "Tobias", "Ines", "Kofi", "Lena", "Arjun", "Sofia", "Emeka", "Hana", "Luca",
  "Yara", "Mateo", "Freya", "Omar", "Nadia", "Jonas", "Priya", "Elias", "Chiara", "Kenji",
  "Amara", "Felix", "Leila", "Bruno", "Signe", "Rafael", "Zofia", "Idris", "Mila", "Anders",
  "Noor", "Dario", "Elin", "Tariq", "Vera", "Hugo", "Ayla", "Nikolai", "Rosa", "Sami",
];
const LAST_NAMES = [
  "Ostby", "Varga", "Mensah", "Lindqvist", "Okafor", "Brandt", "Moreau", "Castillo", "Novak", "Sato",
  "Haddad", "Kowalski", "Reyes", "Adeyemi", "Fischer", "Rossi", "Nakamura", "Petrov", "Duarte", "Holm",
  "Kaur", "Bianchi", "Eriksen", "Farouk", "Janssen", "Lopes", "Marek", "Nilsen", "Oyelaran", "Quinn",
  "Renner", "Szabo", "Tanaka", "Ueda", "Vidal", "Weiss", "Yilmaz", "Zeller", "Abara", "Costa",
];
const DEPARTMENTS = [
  "Logistics", "Finance", "Research", "Legal", "Support", "Design", "Sales", "Security", "Facilities", "Training",
];
const BADGE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

type StaffRecord = { number: number; name: string; department: string; office: string; badge: string; manager: number };

const pad = (n: number) => String(n).padStart(4, "0");

export function generateDirectory(rng: Rng, level: number): { text: string; records: StaffRecord[] } {
  const count = RECORDS_BY_LEVEL[level - 1];
  const names = rng.shuffle(FIRST_NAMES.flatMap((f) => LAST_NAMES.map((l) => `${f} ${l}`))).slice(0, count);

  const badges = new Set<string>();
  while (badges.size < count) {
    badges.add(`${rng.pick([...BADGE_LETTERS])}${rng.int(1, 9)}-${rng.int(1000, 9999)}`);
  }
  const badgeList = [...badges];

  const records: StaffRecord[] = names.map((name, k) => {
    let manager = rng.int(1, count);
    while (manager === k + 1) manager = rng.int(1, count);
    return {
      number: k + 1,
      name,
      department: rng.pick(DEPARTMENTS),
      office: `${rng.pick([..."ABCDEF"])}-${rng.int(100, 499)}`,
      badge: badgeList[k],
      manager,
    };
  });

  const lines = rng
    .shuffle(records)
    .map(
      (r) =>
        `Record ${pad(r.number)} | Name: ${r.name} | Department: ${r.department} | Office: ${r.office} | Badge: ${r.badge} | Manager: Record ${pad(r.manager)}`,
    );
  const text = ["Staff directory. Each person's manager is given as a record number.", "", ...lines].join("\n");

  return { text, records };
}

export function generateLongContextQuestion(
  rng: Rng,
  records: StaffRecord[],
  used: Set<number>,
): { prompt: string; expected: string } {
  let start = rng.pick(records);
  while (used.has(start.number)) start = rng.pick(records);
  used.add(start.number);

  const byNumber = new Map(records.map((r) => [r.number, r]));
  const manager = byNumber.get(start.manager)!;
  const managersManager = byNumber.get(manager.manager)!;

  const prompt = [
    `Using the staff directory above: start at the person named ${start.name}.`,
    "Go to their manager, then to that manager's manager.",
    "What is the badge code of the person you end at? Write only the badge code on the last line.",
  ].join(" ");

  return { prompt, expected: managersManager.badge };
}

export function gradeLongContext(text: string, expected: string): Grade {
  const badge = text.match(/[A-Z]\d-\d{4}/g)?.at(-1);
  return badge === expected ? { passed: true } : { passed: false, note: `got ${badge ?? "no badge code"}` };
}
