# Architecture

A modular pipeline, not one giant prompt. Each stage has one job, and the deterministic code around the AI enforces the rules that must never depend on a model.

```
Instagram DM
  │  (ManyChat External Request  or  Meta Instagram webhook)
  ▼
DM INGESTION ............ src/pipeline/agent.ts  ingestInbound()
  │  verify signature · de-duplicate by provider message id · cancel stale follow-ups/drafts
  ▼
CONTACT / LEAD MATCHING . leads table (platform + platform_user_id), email/handle matching for payments
  ▼
CONVERSATION MEMORY ..... messages table (raw, never summarised away) + lead_notes (facts with source message)
  │  wait INBOUND_QUIET_PERIOD_SECONDS so she can finish typing; per-lead lock
  ▼
LEAD ANALYSIS (AI) ...... prompts/lead-analysis.md → LeadAnalysisSchema (Zod, structured output)
  + SIGNALS (rules) ..... src/agents/signals.ts   stop / refund / dispute / medical / buying intent …
  + SCORING ............. src/agents/scoring.ts   deterministic floor + AI score → cold/warm/hot/very_hot
  ▼
SALES SUPERVISOR ........ src/agents/supervisor.ts
  │  pre-rules  : takeover · stop · sensitive → handoff · open handoff · stopped · "i paid" · no · low confidence
  │  AI         : prompts/sales-supervisor.md → SalesDecisionSchema
  │  post-rules : active+priced products only · no re-selling purchases · kit fit + stock ·
  │               payment plan/checkout/booking must exist · can't-afford compassion rule ·
  │               very hot + high ticket → Lee · confidence threshold
  ▼
FACTS ................... src/agents/facts.ts  the ONLY source of prices, plans, links, stock, shipping, testimonials
  ▼
RESPONSE GENERATOR (AI) . prompts/response-generator.md + prompts/brand-voice.md → 1–4 bubbles
  ▼
SAFETY CHECK ............ src/agents/safety.ts
  │  rules: every $ amount and link must be in FACTS · no invented discounts · shipping only with
  │         verified fulfilment · income/pressure/guilt/leverage/debt/medical/legal/tax/quit-job/false-action
  │  AI   : prompts/safety-validator.md
  │  fail → regenerate once with the issues → fail again → handoff, nothing sent
  ▼
MESSAGE SEND ............ src/pipeline/sender.ts
  │  draft mode: saved for approval · auto mode: re-checks takeover/stop/handoff/newer message/24h window
  │  idempotency key per bubble · ordered bubbles with a small delay
  ▼
CRM UPDATE .............. lead fields, offers_made, status, audit_log
  ▼
FOLLOW-UP SCHEDULER ..... src/pipeline/followups.ts  capped, in send hours, inside the 24h window, re-checked before running
```

Outcomes arrive separately through webhooks (`src/pipeline/outcomes.ts`):

- **payments** (Stripe, PayPal, Square, Kajabi): matched to the lead by metadata, email or Instagram handle. The purchase is recorded, the lead is marked as a customer, sales follow-ups are cancelled, and the AI stops selling. Refunds and disputes create an urgent handoff.
- **bookings** (Calendly): `call_booked`, nurture stops.

## Scheduling

- **Realtime:** a webhook stores the message and schedules a debounced reply after the quiet period.
- **Periodic safety check** (`agent.tick()`, every `MESSAGE_CHECK_INTERVAL_MINUTES`): handles unprocessed messages, due follow-ups, retries of failed sends, and a count of open handoffs. It runs in-process by default (`src/scheduler/scheduler.ts`), or from an external cron via `POST /internal/tick` or `npm run tick`.

## Concurrency and idempotency

- `messages UNIQUE(platform, platform_message_id)` means a duplicate webhook is stored once and processed once.
- `processed_at` on inbound messages marks a message as done, so it is never processed twice.
- `lead_locks` is a per-lead lease lock, so two workers can't reply to the same lead at once.
- `outbound_messages.idempotency_key` (`lead:trigger:ref:bubble`) means the same decision can't create or send bubbles twice.
- `webhook_events UNIQUE(provider, event_id)` and `purchases UNIQUE(provider, transaction_id)` de-duplicate payment and booking webhooks.

## Human control

- `human_takeover = true`: the AI still records and analyses the conversation but sends nothing. This is set from the dashboard or automatically when Lee replies in the Instagram app (Meta echo events).
- **Resume AI**: clears takeover and resolves the handoff. Messages that arrived during the takeover count as handled. A lead who asked not to be contacted stays stopped.
- **Open handoff**: the AI stays quiet for that lead until Lee resolves it.
- **Automation stopped** (no, stop, purchased, call booked, refund): if the lead writes again, it becomes a handoff. The AI never restarts selling on its own.

## Audit log

Every stage writes to `audit_log` with the run id, prompt name and version, model, and the data it used or produced: analysis, score breakdown, supervisor decision and rule adjustments, drafts with the facts shown to the model, safety verdicts, sends and blocks, and admin actions (`actor = human`). The lead page in the dashboard shows the full trail.

## Swapping providers

| Interface | File | Implementations |
|---|---|---|
| `LLMProvider` | `src/llm/provider.ts` | `AnthropicProvider`, `MockLLMProvider` |
| `MessagingProvider` | `src/integrations/messaging/provider.ts` | `ManyChatProvider`, `MetaInstagramProvider`, `MockMessagingProvider` |
| `PaymentProvider` | `src/integrations/payments/provider.ts` | Stripe, PayPal, Square, Kajabi |
| `BookingProvider` | `src/integrations/booking/provider.ts` | Calendly (Google Calendar stub) |
| repositories | `src/db/repositories.ts` | SQLite (Node built-in). The interface is small enough to port to Postgres. |

## Why some things are the way they are

- **Draft mode by default.** It's the safest way to learn whether the AI sounds like Lee before it talks to anyone.
- **Rules around the AI.** Prices, links, stop requests, refunds and stock are business facts, not judgement calls, so they're enforced in code.
- **24-hour window.** Meta only allows automated replies within 24 hours of the lead's last message. A follow-up that would fall outside it becomes a low-priority "manual follow-up suggested" item for Lee instead.
- **AI refusals become handoffs**, rather than being retried on another model. If the model won't handle a conversation, Lee should see it.
- **Attribution is descriptive.** "AI-assisted revenue" means the AI was in the conversation before the sale and Lee wasn't. It isn't a causal claim.
