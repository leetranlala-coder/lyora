import { readFileSync } from "node:fs";
import { z } from "zod";
import { getConfig } from "../config.js";
import { openDatabase } from "../db/database.js";
import { createRepos } from "../db/repositories.js";
import { ProductType } from "../domain/types.js";

/** Load config/products.json (products, stock, social proof) into the database. Safe to re-run. */

const File = z.object({
  products: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9-]+$/),
      name: z.string(),
      type: ProductType,
      active: z.boolean(),
      price: z.number().positive().nullable(),
      currency: z.string().default("AUD"),
      payment_plan_available: z.boolean(),
      payment_plan_description: z.string().nullable(),
      includes: z.array(z.string()),
      excludes: z.array(z.string()),
      checkout_url: z.string().url().nullable(),
      payment_plan_checkout_url: z.string().url().nullable(),
      booking_url: z.string().url().nullable(),
      stock_required: z.boolean(),
      sku: z.string().nullable(),
      external_ids: z.record(z.string(), z.string()),
      notes: z.string().nullable(),
    }),
  ),
  stock: z.array(
    z.object({
      sku: z.string(),
      product_name: z.string(),
      stock_quantity: z.number().int().nullable(),
      stock_status: z.enum(["in_stock", "low_stock", "out_of_stock", "unknown"]),
      fulfilment_days: z.number().int().nullable(),
      fulfilment_verified: z.boolean(),
      shipping_enabled: z.boolean(),
    }),
  ),
  social_proof: z.array(
    z.object({
      id: z.string(),
      student_name_or_alias: z.string(),
      problem_before: z.string().nullable(),
      result: z.string().nullable(),
      quote: z.string().nullable(),
      approved_for_use: z.boolean(),
      source: z.string().nullable(),
      tags: z.array(z.string()),
    }),
  ),
});

const path = process.argv[2] ?? "config/products.json";
const data = File.parse(JSON.parse(readFileSync(path, "utf8")));
const cfg = getConfig();
const repos = createRepos(openDatabase(cfg.DATABASE_PATH));
const now = new Date().toISOString();

const warnings: string[] = [];
for (const p of data.products) {
  if (p.active && p.price === null) warnings.push(`${p.id}: active but has no price — the AI will hand these leads to you`);
  if (p.active && !p.checkout_url) warnings.push(`${p.id}: active but has no checkout_url — the AI can't send an enrolment link`);
  if (p.payment_plan_available && !p.payment_plan_description) warnings.push(`${p.id}: payment plan enabled but no description — the AI won't offer it`);
  if (p.stock_required && !data.stock.some((s) => s.sku === p.sku)) warnings.push(`${p.id}: stock_required but no stock row for sku ${p.sku}`);
  repos.products.upsert(p, now);
}
for (const s of data.stock) repos.stock.upsert(s, now);
for (const sp of data.social_proof) repos.proof.upsert(sp, now);

console.log(`seeded ${data.products.length} products (${data.products.filter((p) => p.active).length} active), ${data.stock.length} stock rows, ${data.social_proof.filter((s) => s.approved_for_use).length} approved testimonials`);
for (const w of warnings) console.log(`  ! ${w}`);
