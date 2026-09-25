// Long context: follow a chain of references through a large staff directory.
// Difficulty = a bigger directory (roughly 3k to 33k tokens), more steps up the chain, and from
// level 3 on, a step back down it: finding everyone who reports to someone means reading every record.
// All questions at one level share the same document, so it can be cached.
import type { Rng } from "./rng.ts";
import type { Grade } from "./types.ts";

type Level = { records: number; hops: number; then: "badge" | "highestReport" | "countReports" };
const LEVELS: Level[] = [
  { records: 100, hops: 2, then: "badge" },
  { records: 250, hops: 3, then: "badge" },
  { records: 500, hops: 1, then: "highestReport" },
  { records: 800, hops: 2, then: "countReports" },
  { records: 1200, hops: 3, then: "countReports" },
];

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
  const count = LEVELS[level - 1].records;
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
  level: number,
  records: StaffRecord[],
  used: Set<number>,
): { prompt: string; expected: string } {
  const { hops, then } = LEVELS[level - 1];
  const byNumber = new Map(records.map((r) => [r.number, r]));
  const reportsOf = (r: StaffRecord) => records.filter((x) => x.manager === r.number);
  const climb = (r: StaffRecord) => {
    for (let k = 0; k < hops; k++) r = byNumber.get(r.manager)!;
    return r;
  };
  // Reverse steps need someone with a few direct reports, so the answer depends on finding all of them.
  const minReports = then === "badge" ? 0 : 2;

  let start = rng.pick(records);
  while (used.has(start.number) || reportsOf(climb(start)).length < minReports) start = rng.pick(records);
  used.add(start.number);
  const end = climb(start);

  const steps = ["Go to their manager", ...Array.from({ length: hops - 1 }, () => "then to that person's manager")].join(", ");
  const intro = `Using the staff directory above: start at the person named ${start.name}. ${steps}.`;
  switch (then) {
    case "badge":
      return {
        prompt: `${intro} What is the badge code of the person you end at? Write only the badge code on the last line.`,
        expected: end.badge,
      };
    case "highestReport": {
      const highest = reportsOf(end).at(-1)!; // records are in number order
      return {
        prompt: `${intro} Of all the people whose manager is the person you end at, find the one with the highest record number. What is their badge code? Write only the badge code on the last line.`,
        expected: highest.badge,
      };
    }
    case "countReports":
      return {
        prompt: `${intro} How many people in the directory have the person you end at as their manager? Write only the number on the last line.`,
        expected: String(reportsOf(end).length),
      };
  }
}

// The expected answer is either a badge code or a count.
export function gradeLongContext(text: string, expected: string): Grade {
  if (/^\d+$/.test(expected)) {
    const last = text.trim().split("\n").at(-1) ?? "";
    const got = last.match(/\d+/g)?.at(-1);
    return got === expected ? { passed: true } : { passed: false, note: `got ${got ?? "no number"}` };
  }
  const badge = text.match(/[A-Z]\d-\d{4}/g)?.at(-1);
  return badge === expected ? { passed: true } : { passed: false, note: `got ${badge ?? "no badge code"}` };
}
