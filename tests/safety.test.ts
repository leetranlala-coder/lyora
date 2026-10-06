import { describe, expect, it } from "vitest";
import { deterministicCheck } from "../src/agents/safety.js";
import type { Fact } from "../src/llm/provider.js";

const facts: Fact[] = [
  { id: "F1", type: "price", product_id: "c", text: "The Online Nail Course costs $450 AUD" },
  { id: "F2", type: "payment_plan", product_id: "c", text: "payment plan for The Online Nail Course: 9 weekly payments of $50" },
  { id: "F3", type: "checkout_link", product_id: "c", text: "checkout link: https://www.lyora.com.au/offers/abc/checkout" },
];
const blocks = (msgs: string[], f: Fact[] = facts, action = "ANSWER_QUESTION" as const) =>
  deterministicCheck(msgs, f, action)
    .filter((i) => i.severity === "block")
    .map((i) => i.type);

describe("deterministic safety checks", () => {
  it("allows verified prices, plan amounts and links", () => {
    expect(blocks(["it's $450 or 9 weekly payments of $50 babe", "here's the link https://www.lyora.com.au/offers/abc/checkout"])).toEqual([]);
  });
  it("blocks invented prices", () => {
    expect(blocks(["it's only $399 this week"])).toContain("unverified_price");
  });
  it("blocks invented links", () => {
    expect(blocks(["pay here https://bit.ly/xyz"])).toContain("unverified_link");
  });
  it("blocks invented discounts", () => {
    expect(blocks(["i can do 20% off for you"])).toContain("invented_discount");
  });
  it("blocks income guarantees", () => {
    expect(blocks(["you'll make $1000 a week easily"])).toEqual(expect.arrayContaining(["income_claim"]));
    expect(blocks(["it honestly pays for itself"])).toContain("income_claim");
  });
  it("blocks pressure and guilt", () => {
    expect(blocks(["if you really wanted it you'd find the money"])).toContain("pressure");
    expect(blocks(["only 2 spots left, don't miss out!"])).toContain("pressure");
  });
  it("blocks using her kids as leverage", () => {
    expect(blocks(["do it for your kids babe"])).toContain("leverage");
  });
  it("blocks encouraging debt", () => {
    expect(blocks(["you could just put it on your credit card"])).toContain("debt");
  });
  it("blocks medical / tax content", () => {
    expect(blocks(["if you're allergic just use gloves"])).toContain("medical_legal_tax");
    expect(blocks(["you'll need an abn for that"])).toContain("medical_legal_tax");
  });
  it("blocks shipping claims without verified fulfilment", () => {
    expect(blocks(["the kit ships in 2 business days"])).toContain("unverified_shipping");
    expect(
      blocks(["the kit ships about 2 business days after payment"], [...facts, { id: "F9", type: "fulfilment", text: "shipped about 2 business days after payment" }]),
    ).toEqual([]);
  });
  it("blocks telling her to quit her job", () => {
    expect(blocks(["honestly just quit your job babe"])).toContain("quit_job");
  });
  it("blocks false claims of actions", () => {
    expect(blocks(["i've just sent your kit xx"])).toContain("false_action");
  });
  it("enforces bubble limits", () => {
    expect(blocks(["a", "b", "c", "d", "e"])).toContain("too_many_bubbles");
    expect(blocks(["x".repeat(600)])).toContain("too_long");
  });
  it("closing message after a no can't contain prices or links", () => {
    expect(blocks(["no worries! it's $450 if you change your mind"], facts, "MARK_NOT_INTERESTED" as never)).toContain("ignored_no");
  });
  it("style issues don't block", () => {
    const issues = deterministicCheck(["what do you think?", "when would you start?"], facts, "ASK_QUALIFYING_QUESTION");
    expect(issues.some((i) => i.severity === "style")).toBe(true);
    expect(issues.some((i) => i.severity === "block")).toBe(false);
  });
});
