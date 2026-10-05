import type { DB } from "./database.js";
import { tx } from "./database.js";
import { newId } from "../util/ids.js";
import type {
  FollowUp,
  HandoffPriority,
  Lead,
  LeadAnalysis,
  Message,
  OutboundMessage,
  Product,
  Purchase,
  SocialProof,
  StockItem,
} from "../domain/types.js";

type Row = Record<string, unknown>;
const b = (v: unknown) => v === 1 || v === true;
const j = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string" || v === "") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
type SqlValue = string | number | null | bigint | Uint8Array;
const toSql = (v: unknown): SqlValue => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (Array.isArray(v) || (typeof v === "object" && !(v instanceof Uint8Array))) return JSON.stringify(v);
  return v as SqlValue;
};

// ---------------------------------------------------------------- mappers
function mapLead(r: Row): Lead {
  return {
    id: String(r.id),
    platform: String(r.platform),
    platform_user_id: String(r.platform_user_id),
    username: s(r.username),
    display_name: s(r.display_name),
    email: s(r.email),
    phone: s(r.phone),
    source: s(r.source),
    status: String(r.status),
    lead_temperature: r.lead_temperature as Lead["lead_temperature"],
    lead_score: Number(r.lead_score),
    experience_level: String(r.experience_level),
    current_job: s(r.current_job),
    main_goal: s(r.main_goal),
    pain_points: j(r.pain_points, []),
    objections: j(r.objections, []),
    budget_concern: b(r.budget_concern),
    payment_plan_interest: b(r.payment_plan_interest),
    kit_needed: b(r.kit_needed),
    kit_interest: b(r.kit_interest),
    course_interest: b(r.course_interest),
    coaching_interest: b(r.coaching_interest),
    call_interest: b(r.call_interest),
    recommended_offer: s(r.recommended_offer),
    ai_summary: s(r.ai_summary),
    analysis: j<LeadAnalysis | null>(r.analysis_json, null),
    last_inbound_message_at: s(r.last_inbound_message_at),
    last_outbound_message_at: s(r.last_outbound_message_at),
    first_response_at: s(r.first_response_at),
    follow_up_due_at: s(r.follow_up_due_at),
    follow_up_count: Number(r.follow_up_count),
    automation_status: r.automation_status as Lead["automation_status"],
    stop_reason: s(r.stop_reason),
    human_takeover: b(r.human_takeover),
    human_takeover_at: s(r.human_takeover_at),
    handoff_required: b(r.handoff_required),
    handoff_reason: s(r.handoff_reason),
    handoff_priority: s(r.handoff_priority) as HandoffPriority | null,
    handoff_created_at: s(r.handoff_created_at),
    handoff_resolved_at: s(r.handoff_resolved_at),
    call_booked: b(r.call_booked),
    purchased: b(r.purchased),
    customer_value: Number(r.customer_value),
    needs_processing: b(r.needs_processing),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

function mapMessage(r: Row): Message {
  return {
    id: String(r.id),
    lead_id: String(r.lead_id),
    platform: String(r.platform),
    platform_message_id: s(r.platform_message_id),
    direction: r.direction as Message["direction"],
    content: String(r.content),
    sender_type: r.sender_type as Message["sender_type"],
    ai_generated: b(r.ai_generated),
    human_generated: b(r.human_generated),
    outbound_message_id: s(r.outbound_message_id),
    processed_at: s(r.processed_at),
    created_at: String(r.created_at),
  };
}

function mapProduct(r: Row): Product {
  return {
    id: String(r.id),
    name: String(r.name),
    type: r.type as Product["type"],
    active: b(r.active),
    price: r.price === null || r.price === undefined ? null : Number(r.price),
    currency: String(r.currency),
    payment_plan_available: b(r.payment_plan_available),
    payment_plan_description: s(r.payment_plan_description),
    includes: j(r.includes, []),
    excludes: j(r.excludes, []),
    checkout_url: s(r.checkout_url),
    payment_plan_checkout_url: s(r.payment_plan_checkout_url),
    booking_url: s(r.booking_url),
    stock_required: b(r.stock_required),
    sku: s(r.sku),
    external_ids: j(r.external_ids, {}),
    notes: s(r.notes),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

function mapStock(r: Row): StockItem {
  return {
    sku: String(r.sku),
    product_name: String(r.product_name),
    stock_quantity: r.stock_quantity === null ? null : Number(r.stock_quantity),
    stock_status: r.stock_status as StockItem["stock_status"],
    fulfilment_days: r.fulfilment_days === null ? null : Number(r.fulfilment_days),
    fulfilment_verified: b(r.fulfilment_verified),
    shipping_enabled: b(r.shipping_enabled),
    updated_at: String(r.updated_at),
  };
}

function mapFollowUp(r: Row): FollowUp {
  return {
    id: String(r.id),
    lead_id: String(r.lead_id),
    scheduled_at: String(r.scheduled_at),
    reason: String(r.reason),
    context: String(r.context),
    attempt_number: Number(r.attempt_number),
    status: r.status as FollowUp["status"],
    status_reason: s(r.status_reason),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

function mapOutbound(r: Row): OutboundMessage {
  return {
    id: String(r.id),
    lead_id: String(r.lead_id),
    batch_id: String(r.batch_id),
    position: Number(r.position),
    content: String(r.content),
    status: r.status as OutboundMessage["status"],
    idempotency_key: String(r.idempotency_key),
    trigger: r.trigger as OutboundMessage["trigger"],
    trigger_ref: s(r.trigger_ref),
    decision_action: s(r.decision_action),
    provider_message_id: s(r.provider_message_id),
    error: s(r.error),
    attempts: Number(r.attempts),
    edited_by_human: b(r.edited_by_human),
    created_at: String(r.created_at),
    sent_at: s(r.sent_at),
  };
}

function mapPurchase(r: Row): Purchase {
  return {
    id: String(r.id),
    lead_id: s(r.lead_id),
    product_id: s(r.product_id),
    provider: String(r.provider),
    provider_transaction_id: String(r.provider_transaction_id),
    amount: Number(r.amount),
    currency: String(r.currency),
    status: r.status as Purchase["status"],
    is_payment_plan: b(r.is_payment_plan),
    customer_email: s(r.customer_email),
    attribution: s(r.attribution),
    purchased_at: String(r.purchased_at),
  };
}

// ---------------------------------------------------------------- repos
export class LeadRepository {
  constructor(private db: DB) {}

  get(id: string): Lead | null {
    const r = this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Row | undefined;
    return r ? mapLead(r) : null;
  }

  findByPlatformUser(platform: string, platformUserId: string): Lead | null {
    const r = this.db
      .prepare("SELECT * FROM leads WHERE platform = ? AND platform_user_id = ?")
      .get(platform, platformUserId) as Row | undefined;
    return r ? mapLead(r) : null;
  }

  findByEmail(email: string): Lead | null {
    const r = this.db
      .prepare("SELECT * FROM leads WHERE lower(email) = lower(?) ORDER BY updated_at DESC LIMIT 1")
      .get(email) as Row | undefined;
    return r ? mapLead(r) : null;
  }

  findByUsername(username: string): Lead | null {
    const r = this.db
      .prepare("SELECT * FROM leads WHERE lower(username) = lower(?) ORDER BY updated_at DESC LIMIT 1")
      .get(username.replace(/^@/, "")) as Row | undefined;
    return r ? mapLead(r) : null;
  }

  upsertFromChannel(input: {
    platform: string;
    platform_user_id: string;
    username?: string | null;
    display_name?: string | null;
    email?: string | null;
    source?: string | null;
    now: string;
  }): Lead {
    const existing = this.findByPlatformUser(input.platform, input.platform_user_id);
    if (existing) {
      this.update(existing.id, {
        username: input.username ?? existing.username,
        display_name: input.display_name ?? existing.display_name,
        email: existing.email ?? input.email ?? null,
        updated_at: input.now,
      });
      return this.get(existing.id)!;
    }
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO leads (id, platform, platform_user_id, username, display_name, email, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.platform,
        input.platform_user_id,
        input.username ?? null,
        input.display_name ?? null,
        input.email ?? null,
        input.source ?? null,
        input.now,
        input.now,
      );
    return this.get(id)!;
  }

  /** Partial update. Keys are column names; arrays/objects are JSON-encoded, booleans become 0/1. */
  update(id: string, fields: Record<string, unknown>) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    for (const k of keys) if (!/^[a-z_]+$/.test(k)) throw new Error(`bad column ${k}`);
    const sql = `UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => toSql(fields[k])), id);
  }

  list(opts: { temperature?: string; handoff?: boolean; limit?: number; search?: string } = {}): Lead[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (opts.temperature) {
      where.push("lead_temperature = ?");
      params.push(opts.temperature);
    }
    if (opts.handoff) where.push("handoff_required = 1 AND handoff_resolved_at IS NULL");
    if (opts.search) {
      where.push("(lower(username) LIKE ? OR lower(display_name) LIKE ? OR lower(email) LIKE ?)");
      const q = `%${opts.search.toLowerCase()}%`;
      params.push(q, q, q);
    }
    const sql = `SELECT * FROM leads ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY COALESCE(last_inbound_message_at, created_at) DESC LIMIT ?`;
    params.push(opts.limit ?? 200);
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapLead);
  }

  needingProcessing(quietBeforeIso: string): Lead[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM leads WHERE needs_processing = 1
             AND (last_inbound_message_at IS NULL OR last_inbound_message_at <= ?)`,
        )
        .all(quietBeforeIso) as Row[]
    ).map(mapLead);
  }

  unresolvedHandoffs(): Lead[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM leads WHERE handoff_required = 1 AND handoff_resolved_at IS NULL
           ORDER BY CASE handoff_priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                    handoff_created_at ASC`,
        )
        .all() as Row[]
    ).map(mapLead);
  }

  setHandoff(id: string, reason: string, priority: HandoffPriority, now: string) {
    const lead = this.get(id);
    if (!lead) return;
    // Keep the original timestamp if a handoff is already open; escalate priority if higher.
    const rank = { low: 0, normal: 1, high: 2, urgent: 3 } as const;
    const open = lead.handoff_required && !lead.handoff_resolved_at;
    const keepPriority = open && lead.handoff_priority && rank[lead.handoff_priority] > rank[priority];
    this.update(id, {
      handoff_required: true,
      handoff_reason: open && lead.handoff_reason && lead.handoff_reason !== reason ? `${lead.handoff_reason}; ${reason}` : reason,
      handoff_priority: keepPriority ? lead.handoff_priority : priority,
      handoff_created_at: open ? lead.handoff_created_at : now,
      handoff_resolved_at: null,
      updated_at: now,
    });
  }
}

export class MessageRepository {
  constructor(private db: DB) {}

  /** Insert an inbound message. Returns null if this provider message id was already stored (duplicate webhook). */
  insertInbound(input: { lead_id: string; platform: string; platform_message_id: string; content: string; created_at: string }): Message | null {
    const id = newId();
    const res = this.db
      .prepare(
        `INSERT INTO messages (id, lead_id, platform, platform_message_id, direction, content, sender_type, created_at)
         VALUES (?, ?, ?, ?, 'inbound', ?, 'lead', ?)
         ON CONFLICT (platform, platform_message_id) DO NOTHING`,
      )
      .run(id, input.lead_id, input.platform, input.platform_message_id, input.content, input.created_at);
    return res.changes === 0 ? null : this.get(id);
  }

  insertOutbound(input: {
    lead_id: string;
    platform: string;
    platform_message_id: string | null;
    content: string;
    sender_type: "ai" | "human";
    outbound_message_id?: string | null;
    created_at: string;
  }): Message | null {
    const id = newId();
    const res = this.db
      .prepare(
        `INSERT INTO messages (id, lead_id, platform, platform_message_id, direction, content, sender_type,
                               ai_generated, human_generated, outbound_message_id, created_at)
         VALUES (?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (platform, platform_message_id) DO NOTHING`,
      )
      .run(
        id,
        input.lead_id,
        input.platform,
        input.platform_message_id,
        input.content,
        input.sender_type,
        input.sender_type === "ai" ? 1 : 0,
        input.sender_type === "human" ? 1 : 0,
        input.outbound_message_id ?? null,
        input.created_at,
      );
    return res.changes === 0 ? null : this.get(id);
  }

  existsByPlatformId(platform: string, platformMessageId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM messages WHERE platform = ? AND platform_message_id = ?")
      .get(platform, platformMessageId);
  }

  get(id: string): Message | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    return r ? mapMessage(r) : null;
  }

  forLead(leadId: string): Message[] {
    return (
      this.db.prepare("SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at ASC, rowid ASC").all(leadId) as Row[]
    ).map(mapMessage);
  }

  unprocessedInbound(leadId: string): Message[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM messages WHERE lead_id = ? AND direction = 'inbound' AND processed_at IS NULL ORDER BY created_at ASC",
        )
        .all(leadId) as Row[]
    ).map(mapMessage);
  }

  markProcessed(ids: string[], now: string) {
    const stmt = this.db.prepare("UPDATE messages SET processed_at = ? WHERE id = ? AND processed_at IS NULL");
    for (const id of ids) stmt.run(now, id);
  }
}

export class NoteRepository {
  constructor(private db: DB) {}
  add(input: { lead_id: string; key: string; value: string; confidence: number; source_message_id: string | null; now: string }) {
    const dup = this.db
      .prepare("SELECT 1 FROM lead_notes WHERE lead_id = ? AND key = ? AND value = ?")
      .get(input.lead_id, input.key, input.value);
    if (dup) return;
    this.db
      .prepare(
        "INSERT INTO lead_notes (id, lead_id, key, value, confidence, source_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(newId(), input.lead_id, input.key, input.value, input.confidence, input.source_message_id, input.now);
  }
  forLead(leadId: string) {
    return this.db.prepare("SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY created_at").all(leadId) as Row[];
  }
}

export class OfferRepository {
  constructor(private db: DB) {}
  record(leadId: string, productId: string, action: string, now: string) {
    this.db
      .prepare("INSERT INTO offers_made (id, lead_id, product_id, action, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(newId(), leadId, productId, action, now);
  }
  forLead(leadId: string): { product_id: string; action: string; created_at: string }[] {
    return this.db
      .prepare("SELECT product_id, action, created_at FROM offers_made WHERE lead_id = ? ORDER BY created_at")
      .all(leadId) as { product_id: string; action: string; created_at: string }[];
  }
}

export class ProductRepository {
  constructor(private db: DB) {}

  getActiveProducts(): Product[] {
    return (this.db.prepare("SELECT * FROM products WHERE active = 1 ORDER BY price").all() as Row[]).map(mapProduct);
  }
  all(): Product[] {
    return (this.db.prepare("SELECT * FROM products ORDER BY active DESC, name").all() as Row[]).map(mapProduct);
  }
  getProductById(id: string): Product | null {
    const r = this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as Row | undefined;
    return r ? mapProduct(r) : null;
  }
  findByExternalId(key: string, value: string): Product | null {
    const r = this.db
      .prepare("SELECT * FROM products WHERE json_extract(external_ids, '$.' || ?) = ?")
      .get(key, value) as Row | undefined;
    return r ? mapProduct(r) : null;
  }
  upsert(p: Omit<Product, "created_at" | "updated_at">, now: string) {
    this.db
      .prepare(
        `INSERT INTO products (id, name, type, active, price, currency, payment_plan_available, payment_plan_description,
            includes, excludes, checkout_url, payment_plan_checkout_url, booking_url, stock_required, sku, external_ids, notes,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name=excluded.name, type=excluded.type, active=excluded.active, price=excluded.price,
            currency=excluded.currency, payment_plan_available=excluded.payment_plan_available,
            payment_plan_description=excluded.payment_plan_description, includes=excluded.includes, excludes=excluded.excludes,
            checkout_url=excluded.checkout_url, payment_plan_checkout_url=excluded.payment_plan_checkout_url,
            booking_url=excluded.booking_url, stock_required=excluded.stock_required, sku=excluded.sku,
            external_ids=excluded.external_ids, notes=excluded.notes, updated_at=excluded.updated_at`,
      )
      .run(
        p.id,
        p.name,
        p.type,
        toSql(p.active),
        p.price,
        p.currency,
        toSql(p.payment_plan_available),
        p.payment_plan_description,
        toSql(p.includes),
        toSql(p.excludes),
        p.checkout_url,
        p.payment_plan_checkout_url,
        p.booking_url,
        toSql(p.stock_required),
        p.sku,
        toSql(p.external_ids),
        p.notes,
        now,
        now,
      );
  }
}

export class StockRepository {
  constructor(private db: DB) {}
  get(sku: string): StockItem | null {
    const r = this.db.prepare("SELECT * FROM stock WHERE sku = ?").get(sku) as Row | undefined;
    return r ? mapStock(r) : null;
  }
  all(): StockItem[] {
    return (this.db.prepare("SELECT * FROM stock ORDER BY product_name").all() as Row[]).map(mapStock);
  }
  upsert(item: Omit<StockItem, "updated_at">, now: string) {
    this.db
      .prepare(
        `INSERT INTO stock (sku, product_name, stock_quantity, stock_status, fulfilment_days, fulfilment_verified, shipping_enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (sku) DO UPDATE SET product_name=excluded.product_name, stock_quantity=excluded.stock_quantity,
           stock_status=excluded.stock_status, fulfilment_days=excluded.fulfilment_days,
           fulfilment_verified=excluded.fulfilment_verified, shipping_enabled=excluded.shipping_enabled, updated_at=excluded.updated_at`,
      )
      .run(
        item.sku,
        item.product_name,
        item.stock_quantity,
        item.stock_status,
        item.fulfilment_days,
        toSql(item.fulfilment_verified),
        toSql(item.shipping_enabled),
        now,
      );
  }
}

export class SocialProofRepository {
  constructor(private db: DB) {}
  approved(): SocialProof[] {
    return (this.db.prepare("SELECT * FROM social_proof WHERE approved_for_use = 1").all() as Row[]).map((r) => ({
      id: String(r.id),
      student_name_or_alias: String(r.student_name_or_alias),
      problem_before: s(r.problem_before),
      result: s(r.result),
      quote: s(r.quote),
      approved_for_use: true,
      source: s(r.source),
      tags: j(r.tags, []),
    }));
  }
  upsert(p: SocialProof, now: string) {
    this.db
      .prepare(
        `INSERT INTO social_proof (id, student_name_or_alias, problem_before, result, quote, approved_for_use, source, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET student_name_or_alias=excluded.student_name_or_alias, problem_before=excluded.problem_before,
           result=excluded.result, quote=excluded.quote, approved_for_use=excluded.approved_for_use, source=excluded.source, tags=excluded.tags`,
      )
      .run(p.id, p.student_name_or_alias, p.problem_before, p.result, p.quote, toSql(p.approved_for_use), p.source, toSql(p.tags), now);
  }
}

export class BrandFactRepository {
  constructor(private db: DB) {}
  active(): string[] {
    return (this.db.prepare("SELECT text FROM brand_facts WHERE active = 1 ORDER BY id").all() as { text: string }[]).map((r) => r.text);
  }
  replaceAll(facts: { id: string; text: string }[], now: string) {
    tx(this.db, () => {
      this.db.exec("DELETE FROM brand_facts");
      const stmt = this.db.prepare("INSERT INTO brand_facts (id, text, active, created_at) VALUES (?, ?, 1, ?)");
      for (const f of facts) stmt.run(f.id, f.text, now);
    });
  }
}

export class PurchaseRepository {
  constructor(private db: DB) {}

  /** Returns the purchase and whether it was newly created (false = duplicate webhook). */
  insert(p: Omit<Purchase, "id">, now: string): { purchase: Purchase; created: boolean } {
    const id = newId();
    const res = this.db
      .prepare(
        `INSERT INTO purchases (id, lead_id, product_id, provider, provider_transaction_id, amount, currency, status,
            is_payment_plan, customer_email, attribution, purchased_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, provider_transaction_id) DO NOTHING`,
      )
      .run(
        id,
        p.lead_id,
        p.product_id,
        p.provider,
        p.provider_transaction_id,
        p.amount,
        p.currency,
        p.status,
        toSql(p.is_payment_plan),
        p.customer_email,
        p.attribution,
        p.purchased_at,
        now,
      );
    const row = this.db
      .prepare("SELECT * FROM purchases WHERE provider = ? AND provider_transaction_id = ?")
      .get(p.provider, p.provider_transaction_id) as Row;
    return { purchase: mapPurchase(row), created: res.changes > 0 };
  }

  setStatus(provider: string, txnId: string, status: Purchase["status"]) {
    this.db.prepare("UPDATE purchases SET status = ? WHERE provider = ? AND provider_transaction_id = ?").run(status, provider, txnId);
  }
  findByTxn(provider: string, txnId: string): Purchase | null {
    const r = this.db
      .prepare("SELECT * FROM purchases WHERE provider = ? AND provider_transaction_id = ?")
      .get(provider, txnId) as Row | undefined;
    return r ? mapPurchase(r) : null;
  }
  forLead(leadId: string): Purchase[] {
    return (this.db.prepare("SELECT * FROM purchases WHERE lead_id = ? ORDER BY purchased_at").all(leadId) as Row[]).map(mapPurchase);
  }
  all(): Purchase[] {
    return (this.db.prepare("SELECT * FROM purchases ORDER BY purchased_at DESC").all() as Row[]).map(mapPurchase);
  }
  unmatched(): Purchase[] {
    return (this.db.prepare("SELECT * FROM purchases WHERE lead_id IS NULL ORDER BY purchased_at DESC").all() as Row[]).map(mapPurchase);
  }
}

export class BookingRepository {
  constructor(private db: DB) {}
  upsert(input: {
    lead_id: string | null;
    provider: string;
    provider_booking_id: string;
    invitee_email: string | null;
    starts_at: string | null;
    status: "booked" | "cancelled";
    now: string;
  }): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO bookings (id, lead_id, provider, provider_booking_id, invitee_email, starts_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, provider_booking_id) DO UPDATE SET status = excluded.status, lead_id = COALESCE(bookings.lead_id, excluded.lead_id)`,
      )
      .run(newId(), input.lead_id, input.provider, input.provider_booking_id, input.invitee_email, input.starts_at, input.status, input.now);
    return res.changes > 0;
  }
  forLead(leadId: string) {
    return this.db.prepare("SELECT * FROM bookings WHERE lead_id = ? ORDER BY created_at").all(leadId) as Row[];
  }
}

export class FollowUpRepository {
  constructor(private db: DB) {}
  schedule(input: { lead_id: string; scheduled_at: string; reason: string; context: string; attempt_number: number; now: string }): FollowUp {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO follow_ups (id, lead_id, scheduled_at, reason, context, attempt_number, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
      )
      .run(id, input.lead_id, input.scheduled_at, input.reason, input.context, input.attempt_number, input.now, input.now);
    return this.get(id)!;
  }
  get(id: string): FollowUp | null {
    const r = this.db.prepare("SELECT * FROM follow_ups WHERE id = ?").get(id) as Row | undefined;
    return r ? mapFollowUp(r) : null;
  }
  due(nowIso: string): FollowUp[] {
    return (
      this.db
        .prepare("SELECT * FROM follow_ups WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at")
        .all(nowIso) as Row[]
    ).map(mapFollowUp);
  }
  scheduledForLead(leadId: string): FollowUp[] {
    return (
      this.db.prepare("SELECT * FROM follow_ups WHERE lead_id = ? AND status = 'scheduled'").all(leadId) as Row[]
    ).map(mapFollowUp);
  }
  forLead(leadId: string): FollowUp[] {
    return (this.db.prepare("SELECT * FROM follow_ups WHERE lead_id = ? ORDER BY scheduled_at").all(leadId) as Row[]).map(mapFollowUp);
  }
  setStatus(id: string, status: FollowUp["status"], reason: string | null, now: string) {
    this.db.prepare("UPDATE follow_ups SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?").run(status, reason, now, id);
  }
  cancelAllForLead(leadId: string, reason: string, now: string): number {
    return Number(
      this.db
        .prepare("UPDATE follow_ups SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE lead_id = ? AND status = 'scheduled'")
        .run(reason, now, leadId).changes,
    );
  }
  /** Follow-ups that reached the lead (sent) or were drafted for Lee (completed). Both count toward the limit. */
  countSentForLead(leadId: string): number {
    const r = this.db.prepare("SELECT COUNT(*) c FROM follow_ups WHERE lead_id = ? AND status IN ('sent', 'completed')").get(leadId) as Row;
    return Number(r.c);
  }
}

export class OutboundRepository {
  constructor(private db: DB) {}

  /** Create outbound bubbles. Returns [] if this batch's idempotency keys already exist. */
  createBatch(input: {
    lead_id: string;
    messages: string[];
    status: "draft" | "queued";
    trigger: "reply" | "followup";
    trigger_ref: string;
    decision_action: string;
    now: string;
  }): OutboundMessage[] {
    const batchId = newId();
    const out: OutboundMessage[] = [];
    tx(this.db, () => {
      input.messages.forEach((content, i) => {
        const key = `${input.lead_id}:${input.trigger}:${input.trigger_ref}:${i}`;
        const id = newId();
        const res = this.db
          .prepare(
            `INSERT INTO outbound_messages (id, lead_id, batch_id, position, content, status, idempotency_key, trigger, trigger_ref,
                decision_action, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (idempotency_key) DO NOTHING`,
          )
          .run(id, input.lead_id, batchId, i, content, input.status, key, input.trigger, input.trigger_ref, input.decision_action, input.now);
        if (res.changes > 0) out.push(this.get(id)!);
      });
    });
    return out;
  }

  get(id: string): OutboundMessage | null {
    const r = this.db.prepare("SELECT * FROM outbound_messages WHERE id = ?").get(id) as Row | undefined;
    return r ? mapOutbound(r) : null;
  }
  batch(batchId: string): OutboundMessage[] {
    return (
      this.db.prepare("SELECT * FROM outbound_messages WHERE batch_id = ? ORDER BY position").all(batchId) as Row[]
    ).map(mapOutbound);
  }
  forLead(leadId: string): OutboundMessage[] {
    return (
      this.db.prepare("SELECT * FROM outbound_messages WHERE lead_id = ? ORDER BY created_at, position").all(leadId) as Row[]
    ).map(mapOutbound);
  }
  byStatus(status: OutboundMessage["status"]): OutboundMessage[] {
    return (
      this.db.prepare("SELECT * FROM outbound_messages WHERE status = ? ORDER BY created_at, position").all(status) as Row[]
    ).map(mapOutbound);
  }
  update(id: string, fields: Partial<Pick<OutboundMessage, "status" | "content" | "provider_message_id" | "error" | "attempts" | "edited_by_human" | "sent_at">>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE outbound_messages SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map((k) => toSql((fields as Record<string, unknown>)[k])), id);
  }
  discardPendingForLead(leadId: string): number {
    return Number(
      this.db
        .prepare("UPDATE outbound_messages SET status = 'discarded' WHERE lead_id = ? AND status IN ('draft', 'queued')")
        .run(leadId).changes,
    );
  }
}

/** Per-lead processing lock with a lease, so two workers never reply to the same lead at once. */
export class LockRepository {
  constructor(private db: DB) {}
  acquire(leadId: string, owner: string, now: Date, ttlSeconds: number): boolean {
    const expires = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO lead_locks (lead_id, locked_by, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (lead_id) DO UPDATE SET locked_by = excluded.locked_by, expires_at = excluded.expires_at
         WHERE lead_locks.expires_at < ?`,
      )
      .run(leadId, owner, expires, now.toISOString());
    return res.changes > 0;
  }
  release(leadId: string, owner: string) {
    this.db.prepare("DELETE FROM lead_locks WHERE lead_id = ? AND locked_by = ?").run(leadId, owner);
  }
}

export class WebhookEventRepository {
  constructor(private db: DB) {}
  /** Returns false if this provider event was already received. */
  markReceived(provider: string, eventId: string, now: string): boolean {
    const res = this.db
      .prepare("INSERT INTO webhook_events (id, provider, event_id, received_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(newId(), provider, eventId, now);
    return res.changes > 0;
  }
}

export class AuditRepository {
  constructor(private db: DB) {}
  write(entry: {
    lead_id?: string | null;
    run_id?: string | null;
    stage: string;
    event: string;
    prompt_name?: string | null;
    prompt_version?: string | null;
    model?: string | null;
    data?: unknown;
    actor?: "agent" | "human" | "system";
    now: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO audit_log (id, lead_id, run_id, stage, event, prompt_name, prompt_version, model, data_json, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        entry.lead_id ?? null,
        entry.run_id ?? null,
        entry.stage,
        entry.event,
        entry.prompt_name ?? null,
        entry.prompt_version ?? null,
        entry.model ?? null,
        entry.data === undefined ? null : JSON.stringify(entry.data),
        entry.actor ?? "agent",
        entry.now,
      );
  }
  forLead(leadId: string, limit = 200) {
    return this.db
      .prepare("SELECT * FROM audit_log WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(leadId, limit) as Row[];
  }
}

export interface Repos {
  db: DB;
  leads: LeadRepository;
  messages: MessageRepository;
  notes: NoteRepository;
  offers: OfferRepository;
  products: ProductRepository;
  stock: StockRepository;
  proof: SocialProofRepository;
  brandFacts: BrandFactRepository;
  purchases: PurchaseRepository;
  bookings: BookingRepository;
  followUps: FollowUpRepository;
  outbound: OutboundRepository;
  locks: LockRepository;
  webhookEvents: WebhookEventRepository;
  audit: AuditRepository;
}

export function createRepos(db: DB): Repos {
  return {
    db,
    leads: new LeadRepository(db),
    messages: new MessageRepository(db),
    notes: new NoteRepository(db),
    offers: new OfferRepository(db),
    products: new ProductRepository(db),
    stock: new StockRepository(db),
    proof: new SocialProofRepository(db),
    brandFacts: new BrandFactRepository(db),
    purchases: new PurchaseRepository(db),
    bookings: new BookingRepository(db),
    followUps: new FollowUpRepository(db),
    outbound: new OutboundRepository(db),
    locks: new LockRepository(db),
    webhookEvents: new WebhookEventRepository(db),
    audit: new AuditRepository(db),
  };
}
