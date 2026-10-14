import type { SalesAction } from "../domain/types.js";
import type { Fact, LLMProvider } from "../llm/provider.js";
import type { Message } from "../domain/types.js";

/**
 * Final gate before anything is sent. Two layers:
 *  1. deterministic checks (cannot be talked around): unverified prices/links/discounts/shipping,
 *     income claims, pressure/guilt, debt, medical/legal/tax content, format limits
 *  2. an LLM review for the things regexes can't judge (tone, leverage, unsupported features)
 */

export interface SafetyIssue {
  type: string;
  detail: string;
  severity: "block" | "style";
}

export interface SafetyResult {
  approved: boolean;
  issues: SafetyIssue[];
  model?: string;
  promptVersion?: string;
}

const MAX_BUBBLES = 4;
const MAX_BUBBLE_CHARS = 500;
const STYLE_BUBBLE_CHARS = 240;

const PATTERNS: { type: string; re: RegExp; detail: string }[] = [
  {
    type: "income_claim",
    re: /\b(guarantee[ds]?|you('ll| will) (definitely )?(make|earn)|earn \$|make \$|\$\s?\d[\d,]*k? (a|per|every) (week|month|day)|pays? for itself|six figures?|financial freedom|replace your (income|salary)|make your money back|easy money)\b/i,
    detail: "income or results claim",
  },
  {
    type: "pressure",
    re: /\b(if you really wanted|you'?ll regret|last chance|only \d+ (spots?|places?) left|don'?t miss out|before it'?s too late|act (now|fast)|what are you waiting for|now or never|price (goes|is going) up (tomorrow|tonight|soon))\b/i,
    detail: "pressure / fake urgency / guilt",
  },
  {
    type: "leverage",
    re: /\b(your (kids|children|baby|family) deserve|for your (kids|children)|do it for your (kids|children|family)|don'?t you want (better|more) for)\b/i,
    detail: "uses personal circumstances as leverage",
  },
  {
    type: "debt",
    re: /\b(credit card|personal loan|take out a loan|borrow (the )?money|put it on (credit|your card)|buy now pay later so you can)\b/i,
    detail: "encourages debt",
  },
  {
    type: "quit_job",
    re: /\b(quit your job|leave your job|hand in your notice|resign)\b/i,
    detail: "tells lead to quit her job",
  },
  {
    type: "medical_legal_tax",
    re: /\b(allerg\w*|infection|fungal|antibiotic|doctor|pregnan\w*|dermatitis|tax|abn|gst|insurance|legal(ly)?|licen[cs]e)\b/i,
    detail: "medical/legal/tax content — must be handled by lee",
  },
  {
    type: "false_action",
    re: /\b(i'?ve (just )?(sent|posted|shipped|booked|added you|enrolled you|refunded)|i'?ll (ship|post|send) (it|your kit) (today|tomorrow|now))\b/i,
    detail: "claims an action the system has not performed",
  },
  {
    type: "impersonation_claim",
    re: /\b(it'?s (really|actually|genuinely|honestly) me|i answer (every|each) (one|message|dm)( myself)?|i'?m (a )?real (person|human)|not a bot|this isn'?t (a bot|automated|ai))\b/i,
    detail: "claims a human is personally typing — never true for an AI draft",
  },
  {
    type: "ai_disclosure_slip",
    re: /\b(as an ai|language model|i'?m an? (bot|assistant|ai)|my instructions|system prompt)\b/i,
    detail: "breaks character / leaks internals",
  },
];

const SHIPPING_RE = /\b(ship(s|ped|ping)?|dispatch(ed)?|posted|postage|deliver(y|ed)?|arrives?|business days|ready to (go|send)|sent out|sent after|pickup)\b/i;
const SHIP_TIME_RE = /\b(\d+\s*(business |working )?(days?|weeks?)|tomorrow|next day|same day|this week|overnight|express|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
const STOCK_RE = /\b(in stock|available now|ready to go|plenty left|back in stock)\b/i;
const DISCOUNT_RE = /(\d+\s?%\s?off|\bdiscount(ed)?\b|\bcoupon\b|\bpromo\b|\bspecial (price|offer|deal)\b|\bon sale\b|\bcheaper for you\b)/i;
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d{1,2})?k?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:aud|dollars|bucks)\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s)<>"']+/gi;

const normMoney = (s: string) => {
  const m = s.toLowerCase().replace(/[$,\s]|aud|dollars|bucks/g, "");
  const k = m.endsWith("k");
  const n = Number(k ? m.slice(0, -1) : m);
  return Number.isFinite(n) ? (k ? n * 1000 : n) : NaN;
};
const stripPunct = (u: string) => u.replace(/[.,!?;:]+$/, "");

export function deterministicCheck(messages: string[], facts: Fact[], action: SalesAction): SafetyIssue[] {
  const issues: SafetyIssue[] = [];
  const factText = facts.map((f) => f.text).join("\n");
  const factMoney = new Set((factText.match(MONEY_RE) ?? []).map(normMoney));
  // payment plan descriptions like "9 weekly payments of $50" — also allow bare numbers that appear in facts
  const factUrls = new Set((factText.match(URL_RE) ?? []).map(stripPunct));
  const hasFulfilmentFact = facts.some((f) => f.type === "fulfilment");
  const hasStockFact = facts.some((f) => f.type === "stock" || f.type === "fulfilment");

  if (messages.length === 0) issues.push({ type: "empty", detail: "no messages", severity: "block" });
  if (messages.length > MAX_BUBBLES) issues.push({ type: "too_many_bubbles", detail: `${messages.length} bubbles`, severity: "block" });

  const all = messages.join("\n");
  messages.forEach((m, i) => {
    if (!m.trim()) issues.push({ type: "empty_bubble", detail: `bubble ${i + 1} is empty`, severity: "block" });
    if (m.length > MAX_BUBBLE_CHARS) issues.push({ type: "too_long", detail: `bubble ${i + 1} is ${m.length} chars`, severity: "block" });
    else if (m.length > STYLE_BUBBLE_CHARS) issues.push({ type: "style", detail: `bubble ${i + 1} is long (${m.length} chars)`, severity: "style" });
    if (/(\*\*|^#+\s|^\s*[-•]\s)/m.test(m)) issues.push({ type: "style", detail: `bubble ${i + 1} uses markdown/bullets`, severity: "style" });
  });

  for (const amt of all.match(MONEY_RE) ?? []) {
    if (!factMoney.has(normMoney(amt))) {
      issues.push({ type: "unverified_price", detail: `amount "${amt}" is not in the product catalogue facts`, severity: "block" });
    }
  }
  for (const url of all.match(URL_RE) ?? []) {
    if (!factUrls.has(stripPunct(url))) {
      issues.push({ type: "unverified_link", detail: `link "${url}" is not an approved link`, severity: "block" });
    }
  }
  if (DISCOUNT_RE.test(all) && !DISCOUNT_RE.test(factText)) {
    issues.push({ type: "invented_discount", detail: "mentions a discount/sale that isn't in the facts", severity: "block" });
  }
  // Shipping POLICY may be repeated if it is in the facts (e.g. "posted anywhere in australia");
  // shipping TIMING ("2 business days", "tomorrow") needs a verified fulfilment fact.
  const shippingPolicyInFacts = SHIPPING_RE.test(factText);
  for (const m of messages) {
    if (!SHIPPING_RE.test(m)) continue;
    if (SHIP_TIME_RE.test(m) && !hasFulfilmentFact) {
      issues.push({ type: "unverified_shipping", detail: "states a shipping/delivery time without verified fulfilment data", severity: "block" });
      break;
    }
    if (!shippingPolicyInFacts && !hasFulfilmentFact) {
      issues.push({ type: "unverified_shipping", detail: "mentions shipping/delivery that isn't in the product facts", severity: "block" });
      break;
    }
  }
  if (STOCK_RE.test(all) && !hasStockFact) {
    issues.push({ type: "unverified_stock", detail: "mentions stock availability without verified stock data", severity: "block" });
  }
  for (const p of PATTERNS) {
    if (p.re.test(all)) issues.push({ type: p.type, detail: p.detail, severity: "block" });
  }

  const questions = (all.match(/\?/g) ?? []).length;
  if (questions > 1) issues.push({ type: "style", detail: `${questions} questions in one reply (aim for one)`, severity: "style" });

  if (action === "MARK_NOT_INTERESTED") {
    if ((all.match(MONEY_RE) ?? []).length || (all.match(URL_RE) ?? []).length) {
      issues.push({ type: "ignored_no", detail: "closing message after a 'no' must not contain prices or links", severity: "block" });
    }
  }
  return issues;
}

export async function validateMessages(
  llm: LLMProvider,
  input: { messages: string[]; facts: Fact[]; conversation: Message[]; action: SalesAction },
): Promise<SafetyResult> {
  const issues = deterministicCheck(input.messages, input.facts, input.action);
  if (issues.some((i) => i.severity === "block")) {
    // No need to spend a model call on something already rejected.
    return { approved: false, issues };
  }
  const res = await llm.validateResponse({ messages: input.messages, facts: input.facts, conversation: input.conversation });
  const llmIssues: SafetyIssue[] = res.output.issues.map((i) => ({
    type: i.type,
    detail: i.detail,
    severity: i.type === "style" ? "style" : res.output.approved ? "style" : "block",
  }));
  const all = [...issues, ...llmIssues];
  return {
    approved: res.output.approved && !all.some((i) => i.severity === "block"),
    issues: all,
    model: res.model,
    promptVersion: res.promptVersion,
  };
}
