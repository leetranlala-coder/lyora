import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const newId = () => randomUUID();

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacHex(secret: string, payload: string | Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function hmacBase64(secret: string, payload: string | Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("base64");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
