import type { DB } from "../db/database.js";
import { newId } from "../util/ids.js";

/**
 * Student payment tracking: what each student agreed to pay, what's come in, what's due when,
 * and who's late. "Late" = instalments whose due date has passed are not covered by payments
 * received so far (payments are applied to the earliest instalments first).
 */

export interface Student {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  instagram: string | null;
  lead_id: string | null;
  package: string | null;
  agreed_total: number | null;
  currency: string;
  training_dates: string | null;
  notes: string | null;
  status: "active" | "completed" | "cancelled";
  created_at: string;
  updated_at: string;
}
export interface StudentPayment {
  id: string;
  student_id: string;
  amount: number;
  paid_at: string;
  method: string | null;
  note: string | null;
}
export interface Instalment {
  id: string;
  student_id: string;
  due_date: string;
  amount: number;
  note: string | null;
}
export interface StudentSummary {
  student: Student;
  paid: number;
  owed: number | null; // null when the total was never written down
  overdue: number;
  next_due: { date: string; amount: number } | null;
  oldest_overdue_date: string | null;
  state: "paid" | "late" | "due_soon" | "on_track" | "no_total" | "no_plan" | "cancelled" | "completed";
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const round = (n: number) => Math.round(n * 100) / 100;

function mapStudent(r: Row): Student {
  return {
    id: String(r.id),
    name: String(r.name),
    email: str(r.email),
    phone: str(r.phone),
    instagram: str(r.instagram),
    lead_id: str(r.lead_id),
    package: str(r.package),
    agreed_total: r.agreed_total === null || r.agreed_total === undefined ? null : Number(r.agreed_total),
    currency: String(r.currency ?? "AUD"),
    training_dates: str(r.training_dates),
    notes: str(r.notes),
    status: (r.status as Student["status"]) ?? "active",
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export class StudentRepository {
  constructor(private db: DB) {}

  all(): Student[] {
    return (this.db.prepare("SELECT * FROM students ORDER BY status = 'active' DESC, name COLLATE NOCASE").all() as Row[]).map(mapStudent);
  }
  get(id: string): Student | null {
    const r = this.db.prepare("SELECT * FROM students WHERE id = ?").get(id) as Row | undefined;
    return r ? mapStudent(r) : null;
  }
  findByEmailOrName(email: string | null, name: string): Student | null {
    if (email) {
      const r = this.db.prepare("SELECT * FROM students WHERE lower(email) = lower(?)").get(email) as Row | undefined;
      if (r) return mapStudent(r);
    }
    const r = this.db.prepare("SELECT * FROM students WHERE lower(name) = lower(?)").get(name.trim()) as Row | undefined;
    return r ? mapStudent(r) : null;
  }
  create(input: Partial<Student> & { name: string }, now: string): Student {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO students (id, name, email, phone, instagram, lead_id, package, agreed_total, currency, training_dates, notes, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.email ?? null,
        input.phone ?? null,
        input.instagram ?? null,
        input.lead_id ?? null,
        input.package ?? null,
        input.agreed_total ?? null,
        input.currency ?? "AUD",
        input.training_dates ?? null,
        input.notes ?? null,
        input.status ?? "active",
        now,
        now,
      );
    return this.get(id)!;
  }
  update(id: string, fields: Partial<Omit<Student, "id" | "created_at">>, now: string) {
    const keys = Object.keys(fields).filter((k) => /^[a-z_]+$/.test(k));
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE students SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => ((fields as Record<string, unknown>)[k] ?? null) as string | number | null), now, id);
  }

  payments(studentId: string): StudentPayment[] {
    return this.db.prepare("SELECT * FROM student_payments WHERE student_id = ? ORDER BY paid_at, created_at").all(studentId) as unknown as StudentPayment[];
  }
  addPayment(input: { student_id: string; amount: number; paid_at: string; method?: string | null; note?: string | null }, now: string) {
    this.db
      .prepare("INSERT INTO student_payments (id, student_id, amount, paid_at, method, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(newId(), input.student_id, round(input.amount), input.paid_at, input.method ?? null, input.note ?? null, now);
  }
  deletePayment(id: string, studentId: string) {
    this.db.prepare("DELETE FROM student_payments WHERE id = ? AND student_id = ?").run(id, studentId);
  }

  instalments(studentId: string): Instalment[] {
    return this.db.prepare("SELECT * FROM student_instalments WHERE student_id = ? ORDER BY due_date").all(studentId) as unknown as Instalment[];
  }
  addInstalment(input: { student_id: string; due_date: string; amount: number; note?: string | null }, now: string) {
    this.db
      .prepare("INSERT INTO student_instalments (id, student_id, due_date, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId(), input.student_id, input.due_date, round(input.amount), input.note ?? null, now);
  }
  deleteInstalment(id: string, studentId: string) {
    this.db.prepare("DELETE FROM student_instalments WHERE id = ? AND student_id = ?").run(id, studentId);
  }
}

/** today = YYYY-MM-DD in the business timezone. */
export function summarise(repo: StudentRepository, s: Student, today: string): StudentSummary {
  const paid = round(repo.payments(s.id).reduce((a, p) => a + p.amount, 0));
  const owed = s.agreed_total === null ? null : round(Math.max(0, s.agreed_total - paid));
  const plan = repo.instalments(s.id);

  // apply payments to instalments oldest-first
  let credit = paid;
  let overdue = 0;
  let oldestOverdue: string | null = null;
  let nextDue: { date: string; amount: number } | null = null;
  for (const i of plan) {
    const covered = Math.min(credit, i.amount);
    credit -= covered;
    const remaining = round(i.amount - covered);
    if (remaining <= 0) continue;
    if (i.due_date < today) {
      overdue += remaining;
      oldestOverdue ??= i.due_date;
    } else if (!nextDue) {
      nextDue = { date: i.due_date, amount: remaining };
    }
  }
  overdue = round(overdue);

  let state: StudentSummary["state"];
  if (s.status === "cancelled") state = "cancelled";
  else if (owed !== null && owed <= 0) state = "paid";
  else if (overdue > 0) state = "late";
  else if (s.agreed_total === null) state = "no_total";
  else if (!plan.length) state = "no_plan";
  else if (nextDue && daysBetween(today, nextDue.date) <= 7) state = "due_soon";
  else state = s.status === "completed" ? "completed" : "on_track";

  return { student: s, paid, owed, overdue, next_due: nextDue, oldest_overdue_date: oldestOverdue, state };
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

export function localDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** A gentle reminder in Lee's voice. Exact numbers only; no pressure, no fees mentioned. */
export function reminderText(sum: StudentSummary): string {
  const first = sum.student.name.split(/\s+/)[0]!.toLowerCase();
  const money = (n: number) => `$${n.toLocaleString("en-AU", { maximumFractionDigits: 2 })}`;
  if (sum.overdue > 0 && sum.oldest_overdue_date) {
    return `hi ${first} 🤍 just a little reminder that ${money(sum.overdue)} was due on ${prettyDate(sum.oldest_overdue_date)}. no stress at all, whenever you're able to send it through, same details as before. let me know if you need anything xx`;
  }
  if (sum.next_due) {
    return `hi ${first} 🤍 just a heads up that your next payment of ${money(sum.next_due.amount)} is due on ${prettyDate(sum.next_due.date)}. same details as before, and let me know if anything changes xx`;
  }
  if (sum.owed && sum.owed > 0) {
    return `hi ${first} 🤍 just checking in on your balance of ${money(sum.owed)}. no stress at all, let me know when works for you xx`;
  }
  return `hi ${first} 🤍 you're all paid up, thank you so much xx`;
}

export function prettyDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(d).toLowerCase().replace(",", "");
}

// ---------------------------------------------------------------- CSV import
/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const money = (v: string | undefined) => {
  if (!v) return null;
  const n = Number(v.replace(/[$,\s]/g, "").replace(/^(\d+(?:\.\d+)?).*$/, "$1"));
  return Number.isFinite(n) && /\d/.test(v) ? n : null;
};

/**
 * Import Lee's student checklist (exported as CSV). Recognised headers (case-insensitive):
 * Student/Name, Email, Phone, Instagram, Package, Agreed total, Paid, Training dates, Do next/Notes, Status.
 * Existing students (same email or name) are updated; "Paid" tops up recorded payments with an
 * "imported balance" entry so the paid total matches the sheet. Rows like TOTALS / notes are skipped.
 */
export function importStudentsCsv(repo: StudentRepository, csv: string, now: Date, timeZone: string) {
  const rows = parseCsv(csv);
  const headerIdx = rows.findIndex((r) => r.some((c) => /^(student|name)$/i.test(c.trim())));
  if (headerIdx < 0) throw new Error("couldn't find a header row with a 'Student' or 'Name' column");
  const header = rows[headerIdx]!.map((h) => h.trim().toLowerCase());
  const col = (...names: RegExp[]) => header.findIndex((h) => names.some((n) => n.test(h)));
  const c = {
    name: col(/^student$/, /^name$/),
    email: col(/e-?mail/),
    phone: col(/phone|mobile/),
    instagram: col(/insta|^ig$|handle/),
    package: col(/package|course|offer|program/),
    total: col(/agreed|total/),
    paid: col(/^paid( \(\$\))?$/, /^paid \$/, /amount paid/),
    dates: col(/training|dates/),
    notes: col(/do next|notes?|status \/ do next/),
    status: col(/^trained/),
  };
  const today = localDate(now, timeZone);
  const nowIso = now.toISOString();
  const result = { created: 0, updated: 0, skipped: [] as string[] };

  for (const r of rows.slice(headerIdx + 1)) {
    const get = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const name = get(c.name);
    if (!name || /^(totals?|how to read|example)/i.test(name)) continue;
    const emailRaw = get(c.email);
    const email = /\S+@\S+\.\S+/.test(emailRaw) ? emailRaw.toLowerCase() : null;
    const total = money(get(c.total));
    const paidSheet = money(get(c.paid));
    const notes = get(c.notes) || null;
    const cancelled = /cancel|withdrew|pulled out/i.test(`${get(c.status)} ${notes ?? ""}`);
    const fields = {
      name,
      email,
      phone: get(c.phone) || (/^\(?phone/i.test(emailRaw) ? emailRaw.replace(/[()]/g, "").replace(/^phone\s*/i, "") : null),
      instagram: get(c.instagram).replace(/^@/, "") || null,
      package: get(c.package) || null,
      agreed_total: total,
      training_dates: get(c.dates) || null,
      notes,
      status: (cancelled ? "cancelled" : "active") as Student["status"],
    };

    let s = repo.findByEmailOrName(email, name);
    if (s) {
      repo.update(s.id, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== "")), nowIso);
      result.updated++;
    } else {
      s = repo.create(fields, nowIso);
      result.created++;
    }
    if (paidSheet !== null) {
      const recorded = repo.payments(s.id).reduce((a, p) => a + p.amount, 0);
      const diff = round(paidSheet - recorded);
      if (diff > 0) repo.addPayment({ student_id: s.id, amount: diff, paid_at: today, method: "imported", note: "paid to date (from spreadsheet)" }, nowIso);
    }
  }
  return result;
}
