import type { Lead } from "../../domain/types.js";
import { newId } from "../../util/ids.js";
import type { MessagingProvider, ParsedWebhook } from "./provider.js";

/** In-memory messaging provider for local runs and tests. Records everything "sent". */
export class MockMessagingProvider implements MessagingProvider {
  readonly name = "mock";
  readonly platform = "instagram";
  readonly sent: { leadId: string; to: string; text: string; idempotencyKey: string; providerMessageId: string }[] = [];
  failNext = 0;

  async sendMessage(lead: Lead, text: string, idempotencyKey: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("mock send failure");
    }
    const providerMessageId = `mock_${newId()}`;
    this.sent.push({ leadId: lead.id, to: lead.platform_user_id, text, idempotencyKey, providerMessageId });
    return { providerMessageId };
  }

  /** Accepts the simple JSON shape used by the simulator: {sender_id, message_id, text, username?, timestamp?} */
  parseWebhook(_headers: Record<string, string | undefined>, rawBody: string): ParsedWebhook {
    const b = JSON.parse(rawBody) as Record<string, string>;
    return {
      inbound: [
        {
          platform: "instagram",
          platform_user_id: String(b.sender_id),
          platform_message_id: String(b.message_id),
          text: String(b.text ?? ""),
          sent_at: b.timestamp ?? new Date().toISOString(),
          username: b.username ?? null,
        },
      ],
      echoes: [],
    };
  }
}
