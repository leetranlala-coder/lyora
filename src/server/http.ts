import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqual } from "../util/ids.js";

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  rawBody: string;
  form: URLSearchParams;
  params: Record<string, string>;
}

export interface Res {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const html = (body: string, status = 200): Res => ({ status, headers: { "content-type": "text/html; charset=utf-8" }, body });
export const json = (data: unknown, status = 200): Res => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
export const text = (body: string, status = 200): Res => ({ status, headers: { "content-type": "text/plain; charset=utf-8" }, body });
export const redirect = (to: string): Res => ({ status: 303, headers: { location: to }, body: "" });

const MAX_BODY = 1_000_000;

export async function readRequest(req: IncomingMessage): Promise<Req> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url ?? "/", "http://local");
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
  const isForm = (headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
  return {
    method: (req.method ?? "GET").toUpperCase(),
    path: url.pathname.replace(/\/+$/, "") || "/",
    query: url.searchParams,
    headers,
    rawBody,
    form: isForm ? new URLSearchParams(rawBody) : new URLSearchParams(),
    params: {},
  };
}

export function writeResponse(res: ServerResponse, r: Res) {
  res.writeHead(r.status, {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    ...r.headers,
  });
  res.end(r.body);
}

type Handler = (req: Req) => Promise<Res> | Res;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  add(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" +
        path.replace(/:(\w+)/g, (_, k: string) => {
          keys.push(k);
          return "([^/]+)";
        }) +
        "$",
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }
  get(p: string, h: Handler) {
    return this.add("GET", p, h);
  }
  post(p: string, h: Handler) {
    return this.add("POST", p, h);
  }
  async handle(req: Req): Promise<Res> {
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(req.path);
      if (!m) continue;
      req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      return r.handler(req);
    }
    return text("not found", 404);
  }
}

/** HTTP basic auth for the admin dashboard. Admin is disabled entirely without a password. */
export function checkBasicAuth(req: Req, user: string, password: string): Res | null {
  if (!password) return text("admin dashboard is disabled: set ADMIN_PASSWORD", 503);
  const h = req.headers.authorization ?? "";
  if (h.startsWith("Basic ")) {
    const [u, ...rest] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
    if (safeEqual(u ?? "", user) && safeEqual(rest.join(":"), password)) return null;
  }
  return { status: 401, headers: { "www-authenticate": 'Basic realm="LYORA admin", charset="UTF-8"', "content-type": "text/plain" }, body: "authentication required" };
}

/** Reject cross-site form posts to the admin (basic auth alone is CSRF-able). */
export function checkSameOrigin(req: Req): Res | null {
  if (req.method !== "POST") return null;
  const host = req.headers.host;
  const origin = req.headers.origin ?? req.headers.referer;
  if (!origin || !host) return text("missing origin", 403);
  try {
    if (new URL(origin).host !== host) return text("cross-origin request blocked", 403);
  } catch {
    return text("bad origin", 403);
  }
  return null;
}

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
