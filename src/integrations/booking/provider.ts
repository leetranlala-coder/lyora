import { hmacHex, safeEqual } from "../../util/ids.js";
import { WebhookAuthError } from "../messaging/provider.js";

export interface BookingEvent {
  provider: string;
  event_id: string;
  booking_id: string;
  status: "booked" | "cancelled";
  email: string | null;
  instagram: string | null;
  starts_at: string | null;
}

export interface BookingProvider {
  readonly name: string;
  handleBookingWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<BookingEvent[]>;
  getBooking?(bookingId: string): Promise<BookingEvent | null>;
}

/**
 * Calendly webhooks (invitee.created / invitee.canceled).
 * Signature: `Calendly-Webhook-Signature: t=<ts>,v1=<hex hmac of "<ts>.<raw body>">`.
 * Add a booking question "What's your Instagram handle?" so bookings can be matched to DMs.
 */
export class CalendlyBookingProvider implements BookingProvider {
  readonly name = "calendly";
  constructor(private signingKey: string) {}

  async handleBookingWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<BookingEvent[]> {
    if (!this.signingKey) throw new WebhookAuthError("CALENDLY_WEBHOOK_SIGNING_KEY not configured");
    const header = headers["calendly-webhook-signature"] ?? "";
    const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
    if (!parts.t || !parts.v1) throw new WebhookAuthError("missing signature");
    if (!safeEqual(parts.v1, hmacHex(this.signingKey, `${parts.t}.${rawBody}`))) throw new WebhookAuthError("bad signature");

    const evt = JSON.parse(rawBody) as { event: string; created_at?: string; payload: Record<string, any> };
    if (evt.event !== "invitee.created" && evt.event !== "invitee.canceled") return [];
    const p = evt.payload ?? {};
    const qa = (p.questions_and_answers as { question: string; answer: string }[] | undefined) ?? [];
    const insta = qa.find((q) => /insta/i.test(q.question))?.answer?.trim().replace(/^@/, "") ?? null;
    const id = String(p.uri ?? p.event ?? "");
    return [
      {
        provider: "calendly",
        event_id: `${evt.event}:${id}`,
        booking_id: id,
        status: evt.event === "invitee.created" ? "booked" : "cancelled",
        email: p.email ?? null,
        instagram: insta,
        starts_at: p.scheduled_event?.start_time ?? null,
      },
    ];
  }
}

/**
 * Google Calendar placeholder. Google Calendar push notifications only say "something changed"
 * and require OAuth + a sync token to fetch details, so they are not wired up yet.
 * Simplest path: use a Calendly (or Kajabi coaching) booking link and the Calendly webhook,
 * or mark calls booked from the admin dashboard.
 */
export class GoogleCalendarBookingProvider implements BookingProvider {
  readonly name = "google_calendar";
  async handleBookingWebhook(): Promise<BookingEvent[]> {
    throw new Error("Google Calendar booking sync is not implemented — see docs/SETUP.md");
  }
}
