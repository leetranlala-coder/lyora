import type { Lead } from "../../domain/types.js";

/** A normalised inbound DM from any channel. */
export interface InboundEvent {
  platform: string; // "instagram"
  platform_user_id: string; // IGSID or ManyChat subscriber id
  platform_message_id: string; // unique per platform — used for idempotency
  text: string;
  sent_at: string; // ISO
  username?: string | null;
  display_name?: string | null;
  email?: string | null;
  source?: string | null;
}

/** A message sent FROM the business account that we did not send ourselves (Lee typing in the app). */
export interface EchoEvent {
  platform: string;
  platform_user_id: string; // the lead
  platform_message_id: string;
  text: string;
  sent_at: string;
}

export interface ParsedWebhook {
  inbound: InboundEvent[];
  echoes: EchoEvent[];
}

export class WebhookAuthError extends Error {}

export interface MessagingProvider {
  readonly name: string;
  readonly platform: string;
  /** Send one DM bubble. Must be safe to call once per idempotency key (callers guarantee this). */
  sendMessage(lead: Lead, text: string, idempotencyKey: string): Promise<{ providerMessageId: string }>;
  /** Verify the request signature and normalise the payload. Throws WebhookAuthError if invalid. */
  parseWebhook(headers: Record<string, string | undefined>, rawBody: string): ParsedWebhook;
  /** Optional: fetch history from the provider (not all providers expose this). */
  getConversation?(lead: Lead): Promise<InboundEvent[]>;
  /** Optional: poll for messages if the provider has no webhooks. */
  getNewMessages?(sinceIso: string): Promise<InboundEvent[]>;
}
