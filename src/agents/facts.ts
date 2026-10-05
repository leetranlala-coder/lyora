import type { LeadAnalysis, Product, SalesDecision, SocialProof, StockItem } from "../domain/types.js";
import type { CatalogueEntry, Fact } from "../llm/provider.js";

/**
 * The response generator may only state what is in its FACTS block.
 * This module is the single place those facts are assembled from the source-of-truth tables,
 * so prices, links, stock and shipping can never come from a prompt or a model's memory.
 */

export function formatPrice(price: number, currency: string): string {
  const n = Number.isInteger(price) ? price.toLocaleString("en-AU") : price.toLocaleString("en-AU", { minimumFractionDigits: 2 });
  return `$${n} ${currency}`;
}

/** A product is sellable only if it is active and its price is known ($0 for free products). */
export function isSellable(p: Product): boolean {
  if (!p.active || p.price === null || p.price === undefined) return false;
  return p.type === "free" ? p.price === 0 : p.price > 0;
}

/** Stock is good enough to recommend a stock-required product (no shipping promise implied). */
export function stockAllowsSale(p: Product, stock: StockItem | null): boolean {
  if (!p.stock_required) return true;
  if (!stock) return true; // unknown: may recommend, but never state availability/shipping
  return stock.stock_status !== "out_of_stock";
}

/** Fulfilment time may be stated only when Lee has verified it and it's in stock. */
export function fulfilmentVerified(stock: StockItem | null): boolean {
  return !!(
    stock &&
    stock.fulfilment_verified &&
    stock.shipping_enabled &&
    stock.fulfilment_days !== null &&
    (stock.stock_status === "in_stock" || stock.stock_status === "low_stock")
  );
}

export function buildCatalogue(products: Product[], stockFor: (sku: string) => StockItem | null): CatalogueEntry[] {
  return products.filter(isSellable).map((p) => {
    const stock = p.sku ? stockFor(p.sku) : null;
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      price: p.price,
      currency: p.currency,
      payment_plan_available: p.payment_plan_available && !!p.payment_plan_description,
      payment_plan_description: p.payment_plan_available ? p.payment_plan_description : null,
      includes: p.includes,
      has_checkout_url: !!p.checkout_url,
      has_booking_url: !!p.booking_url,
      stock_required: p.stock_required,
      stock_status: p.stock_required ? (stock?.stock_status ?? "unknown") : null,
    };
  });
}

export interface FactContext {
  decision: SalesDecision;
  analysis: LeadAnalysis;
  products: Product[]; // products referenced by the decision (already validated as sellable)
  stockFor: (sku: string) => StockItem | null;
  approvedProof: SocialProof[];
  defaultBookingUrl: string | null;
  /** Always-true facts about Lee and LYORA (her story, policies) from config. */
  brandFacts?: string[];
}

export function buildFacts(ctx: FactContext): Fact[] {
  const facts: Fact[] = [];
  let n = 0;
  const add = (f: Omit<Fact, "id">) => facts.push({ id: `F${++n}`, ...f });
  const a = ctx.decision.action;
  const linkActions = new Set(["SEND_ENROLMENT_INFORMATION", "OFFER_PAYMENT_PLAN"]);

  for (const p of ctx.products) {
    add({ type: "product", product_id: p.id, text: `${p.name} (${p.type.replace(/_/g, " ")})` });
    if (p.price !== null) {
      add({ type: "price", product_id: p.id, text: p.price === 0 ? `${p.name} is completely free, no card needed` : `${p.name} costs ${formatPrice(p.price, p.currency)}` });
    }
    if (p.payment_plan_available && p.payment_plan_description) {
      add({ type: "payment_plan", product_id: p.id, text: `payment plan for ${p.name}: ${p.payment_plan_description}` });
    }
    for (const inc of p.includes) add({ type: "includes", product_id: p.id, text: `${p.name} includes: ${inc}` });
    for (const exc of p.excludes) add({ type: "excludes", product_id: p.id, text: `${p.name} does NOT include: ${exc}` });

    if ((linkActions.has(a) || p.price === 0) && p.checkout_url) {
      add({ type: "checkout_link", product_id: p.id, text: `checkout link for ${p.name} (pay in full): ${p.checkout_url}` });
    }
    if (linkActions.has(a) && p.payment_plan_available && p.payment_plan_checkout_url) {
      add({ type: "payment_plan_link", product_id: p.id, text: `checkout link for ${p.name} payment plan: ${p.payment_plan_checkout_url}` });
    }
    if (a === "OFFER_CALL" && p.booking_url) {
      add({ type: "booking_link", product_id: p.id, text: `link to book a call with lee: ${p.booking_url}` });
    }

    if (p.stock_required && p.sku) {
      const stock = ctx.stockFor(p.sku);
      if (stock && (stock.stock_status === "in_stock" || stock.stock_status === "low_stock")) {
        add({ type: "stock", product_id: p.id, text: `${p.name} is currently in stock` });
      }
      if (fulfilmentVerified(stock)) {
        add({
          type: "fulfilment",
          product_id: p.id,
          text: `${p.name} is usually prepared and shipped about ${stock!.fulfilment_days} business days after payment`,
        });
      }
    }
  }

  if (a === "OFFER_CALL" && !facts.some((f) => f.type === "booking_link") && ctx.defaultBookingUrl) {
    add({ type: "booking_link", text: `link to book a call with lee: ${ctx.defaultBookingUrl}` });
  }

  for (const text of ctx.brandFacts ?? []) add({ type: "brand", text });

  // Approved social proof relevant to this lead (max 2). Never fabricated, never edited.
  const wanted = new Set(
    [...ctx.analysis.pain_points, ctx.analysis.experience_level, ctx.analysis.main_goal, ctx.analysis.life_context]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3),
  );
  const relevant = ctx.approvedProof
    .filter((sp) => sp.approved_for_use)
    .map((sp) => ({ sp, hits: sp.tags.filter((t) => wanted.has(t.toLowerCase()) || [...wanted].some((w) => t.toLowerCase().includes(w))).length }))
    .filter((x) => x.hits > 0)
    .sort((x, y) => y.hits - x.hits)
    .slice(0, 2);
  for (const { sp } of relevant) {
    const parts = [sp.problem_before && `before: ${sp.problem_before}`, sp.result && `result: ${sp.result}`, sp.quote && `in her words: "${sp.quote}"`]
      .filter(Boolean)
      .join("; ");
    add({ type: "social_proof", text: `student ${sp.student_name_or_alias} — ${parts}` });
  }

  return facts;
}
