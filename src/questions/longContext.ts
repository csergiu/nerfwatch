// Long context: questions about a large staff directory.
// Difficulty = a bigger directory (roughly 3k to 33k tokens) and questions that need more of it:
// following a chain of managers (levels 1-2), then counting that can't skip a single record,
// such as everyone who reports to someone (3), everyone matching two fields (4),
// or everyone whose manager is in a given department, which means looking up each manager too (5).
// All questions at one level share the same document, so it can be cached.
import type { Rng } from "./rng.ts";
import type { Grade } from "./types.ts";

type Level =
  | { records: number; ask: "badge" | "countReports"; hops: number }
  | { records: number; ask: "countInBuilding" | "countManagedFrom" };
const LEVELS: Level[] = [
  { records: 100, ask: "badge", hops: 2 },
  { records: 250, ask: "badge", hops: 3 },
  { records: 500, ask: "countReports", hops: 2 },
  { records: 800, ask: "countInBuilding" },
  { records: 1200, ask: "countManagedFrom" },
];
const BUILDINGS = "ABCDEF";

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
      office: `${rng.pick([...BUILDINGS])}-${rng.int(100, 499)}`,
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
  used: Set<string>, // questions already asked about this directory
): { prompt: string; expected: string } {
  const config = LEVELS[level - 1];
  const byNumber = new Map(records.map((r) => [r.number, r]));
  const count = (match: (r: StaffRecord) => boolean) => records.filter(match).length;
  const answerNumber = "Write only the number on the last line.";

  // Picks something to ask about that hasn't been asked yet and gives a usable answer.
  const choose = <T>(pick: () => T, key: (t: T) => string, ok: (t: T) => boolean) => {
    let t = pick();
    while (used.has(key(t)) || !ok(t)) t = pick();
    used.add(key(t));
    return t;
  };

  if (config.ask === "badge" || config.ask === "countReports") {
    const climb = (r: StaffRecord) => {
      for (let k = 0; k < config.hops; k++) r = byNumber.get(r.manager)!;
      return r;
    };
    const reports = (r: StaffRecord) => count((x) => x.manager === r.number);
    // Counting needs someone with a few direct reports, so the answer depends on finding all of them.
    const start = choose(
      () => rng.pick(records),
      (r) => r.name,
      (r) => config.ask === "badge" || reports(climb(r)) >= 2,
    );
    const end = climb(start);
    const steps = ["Go to their manager", ...Array.from({ length: config.hops - 1 }, () => "then to that person's manager")].join(", ");
    const intro = `Using the staff directory above: start at the person named ${start.name}. ${steps}.`;
    return config.ask === "badge"
      ? {
          prompt: `${intro} What is the badge code of the person you end at? Write only the badge code on the last line.`,
          expected: end.badge,
        }
      : {
          prompt: `${intro} How many people in the directory have the person you end at as their manager? ${answerNumber}`,
          expected: String(reports(end)),
        };
  }

  if (config.ask === "countInBuilding") {
    const matches = ([department, building]: string[]) =>
      count((r) => r.department === department && r.office.startsWith(`${building}-`));
    const [department, building] = choose(
      () => [rng.pick(DEPARTMENTS), rng.pick([...BUILDINGS])],
      (t) => t.join(),
      (t) => matches(t) >= 3,
    );
    return {
      prompt: `Using the staff directory above: how many people work in the ${department} department and have an office in building ${building} (office codes that start with "${building}-")? ${answerNumber}`,
      expected: String(matches([department, building])),
    };
  }

  const matches = ([department, managers]: string[]) =>
    count((r) => r.department === department && byNumber.get(r.manager)!.department === managers);
  const [department, managers] = choose(
    () => rng.shuffle(DEPARTMENTS).slice(0, 2),
    (t) => t.join(),
    (t) => matches(t) >= 3,
  );
  return {
    prompt: `Using the staff directory above: how many people in the ${department} department have a manager who works in the ${managers} department? ${answerNumber}`,
    expected: String(matches([department, managers])),
  };
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
