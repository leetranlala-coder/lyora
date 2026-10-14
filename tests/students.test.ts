import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { createRepos } from "../src/db/repositories.js";
import { importStudentsCsv, parseCsv, reminderText, summarise } from "../src/pipeline/students.js";
import { buildConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { ManualScheduler } from "../src/scheduler/scheduler.js";
import { MockMessagingProvider } from "../src/integrations/messaging/mock.js";
import type { Req } from "../src/server/http.js";
import { FakeClock, START } from "./helpers.js";

const NOW = "2026-10-06T02:00:00.000Z";
const TODAY = "2026-10-06";
const repo = () => createRepos(openDatabase(":memory:")).students;

describe("student payments", () => {
  it("works out paid, owed, overdue and the next due date", () => {
    const r = repo();
    const s = r.create({ name: "Jess Smith", agreed_total: 1000 }, NOW);
    r.addInstalment({ student_id: s.id, due_date: "2026-09-01", amount: 250 }, NOW);
    r.addInstalment({ student_id: s.id, due_date: "2026-10-01", amount: 250 }, NOW);
    r.addInstalment({ student_id: s.id, due_date: "2026-11-01", amount: 500 }, NOW);
    r.addPayment({ student_id: s.id, amount: 300, paid_at: "2026-09-01" }, NOW);

    const sum = summarise(r, s, TODAY);
    expect(sum.paid).toBe(300);
    expect(sum.owed).toBe(700);
    expect(sum.overdue).toBe(200); // 250 + 250 due, 300 paid
    expect(sum.oldest_overdue_date).toBe("2026-10-01");
    expect(sum.next_due).toEqual({ date: "2026-11-01", amount: 500 });
    expect(sum.state).toBe("late");

    const msg = reminderText(sum);
    expect(msg).toContain("hi jess");
    expect(msg).toContain("$200");
    expect(msg).not.toMatch(/fee|penalt|urgent|immediately/i);

    r.addPayment({ student_id: s.id, amount: 200, paid_at: TODAY }, NOW);
    expect(summarise(r, s, TODAY).state).toBe("on_track");
    r.addPayment({ student_id: s.id, amount: 500, paid_at: TODAY }, NOW);
    expect(summarise(r, s, TODAY).state).toBe("paid");
  });

  it("flags due this week, missing totals and missing plans", () => {
    const r = repo();
    const a = r.create({ name: "A", agreed_total: 500 }, NOW);
    r.addInstalment({ student_id: a.id, due_date: "2026-10-09", amount: 250 }, NOW);
    expect(summarise(r, a, TODAY).state).toBe("due_soon");
    expect(summarise(r, r.create({ name: "B" }, NOW), TODAY).state).toBe("no_total");
    expect(summarise(r, r.create({ name: "C", agreed_total: 400 }, NOW), TODAY).state).toBe("no_plan");
  });

  it("parses quoted csv", () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n')).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
  });

  it("imports the checklist and re-imports without double counting", () => {
    const r = repo();
    const csv = `LYORA student checklist,,,,,,,,
Student,Email,Trained?,Paid in full?,Agreed total ($),Paid ($),Still owed ($),Training dates,Do next
Jess Smith,jess@example.com,Yes,No,"$1,550",$500,"$1,050",18 Oct,send kit
Ana Lee,,No,No,,0,,TBC,confirm price
TOTALS,,,,,500,,,`;
    const res = importStudentsCsv(r, csv, new Date(NOW), "Australia/Perth");
    expect(res).toEqual({ created: 2, updated: 0, skipped: [] });
    const jess = r.findByEmailOrName("jess@example.com", "Jess Smith")!;
    expect(jess.agreed_total).toBe(1550);
    expect(jess.training_dates).toBe("18 Oct");
    expect(summarise(r, jess, TODAY).owed).toBe(1050);
    expect(summarise(r, r.findByEmailOrName(null, "ana lee")!, TODAY).state).toBe("no_total");

    const again = importStudentsCsv(r, csv.replace("$500", "$700"), new Date(NOW), "Australia/Perth");
    expect(again.updated).toBe(2);
    expect(summarise(r, jess, TODAY).paid).toBe(700);
    expect(r.all()).toHaveLength(2);
  });
});

describe("students dashboard", () => {
  const auth = "Basic " + Buffer.from("lee:pw").toString("base64");
  const req = (method: string, path: string, form: Record<string, string> = {}, body?: string): Req => {
    const url = new URL(path, "http://localhost:3000");
    const f = new URLSearchParams(form);
    return { method, path: url.pathname, query: url.searchParams, headers: { host: "localhost:3000", origin: "http://localhost:3000", authorization: auth }, rawBody: body ?? f.toString(), form: f, params: {} };
  };

  it("add student, plan, payment, late on today page", async () => {
    const clock = new FakeClock(START);
    const a = buildApp({ cfg: buildConfig({ DATABASE_PATH: ":memory:", ADMIN_PASSWORD: "pw", ADMIN_USERNAME: "lee", MESSAGING_PROVIDER: "mock", NODE_ENV: "test" }), clock, scheduler: new ManualScheduler(), messaging: new MockMessagingProvider() });
    const created = await a.router.handle(req("POST", "/admin/students/new", { name: "Khloe", agreed_total: "1550", package: "upskilling" }));
    expect(created.status).toBe(303);
    const s = a.repos.students.all()[0]!;
    await a.router.handle(req("POST", `/admin/students/${s.id}/instalments/plan`, { count: "3", amount: "500", every: "month", start: "2026-08-31" }));
    expect(a.repos.students.instalments(s.id).map((i) => i.due_date)).toEqual(["2026-08-31", "2026-09-30", "2026-10-31"]);
    await a.router.handle(req("POST", `/admin/students/${s.id}/payments`, { amount: "500", paid_at: "2026-08-31", method: "bank transfer" }));

    const today = await a.router.handle(req("GET", "/admin"));
    expect(today.body).toContain("payments");
    expect(today.body).toContain("Khloe");
    const detail = await a.router.handle(req("GET", `/admin/students/${s.id}`));
    expect(detail.body).toContain("$500 was due on");
    for (const p of ["/admin/students", "/admin/students?show=late", "/admin/students/new", "/admin/students/import", `/admin/students/${s.id}/edit`]) {
      expect((await a.router.handle(req("GET", p))).status).toBe(200);
    }
  });
});
