# LYORA DM agent

An AI sales and nurturing assistant for LYORA's Instagram DMs. It replies to new enquiries in Lee's voice while she's busy, gets to know each lead before recommending anything, and steps back to Lee whenever a conversation needs a real person.

It starts in **draft mode**: the AI writes the reply, and nothing goes out until Lee approves it in the dashboard.

## What it does

- reads every inbound DM along with the full conversation history
- works out who the lead is: beginner or nail tech, her goal, what she's struggling with, money concerns, whether she needs a kit
- decides the next step: ask one question, answer, nurture, recommend, offer a payment plan or call, send the enrolment link, wait, stop, or hand over to Lee
- writes short, lowercase DM bubbles in Lee's voice
- checks every message before it goes out: no invented prices, links, discounts, shipping times, income claims or pressure
- follows up at most twice, only where it makes sense, and only inside Instagram's 24-hour window
- stops immediately on "no", "stop", a purchase, a booked call, a refund or a complaint
- records everything (leads, conversations, decisions, purchases and revenue) and shows it in a simple dashboard

## Quick start (local, no accounts needed)

```bash
npm install
cp .env.example .env          # set ADMIN_PASSWORD
npm test                      # 55 tests, all offline
npm run seed                  # load config/products.json
npm run simulate              # chat with the agent as if you were a lead
npm run dev                   # dashboard at http://localhost:3000/admin
```

Without an `ANTHROPIC_API_KEY`, the system runs on a simple offline mock so the plumbing can be tested. Add a key to get real replies.

## Before going live

1. **Products.** Open `config/products.json`, check every price, payment plan, inclusion and link, then set `"active": true` on the products the AI may sell, and run `npm run seed`. The AI never sells an inactive product or one without a price.
2. **Kit stock.** Fill in the `stock` section. The AI only mentions shipping times once `fulfilment_verified` is `true`.
3. **Testimonials.** Add real ones under `social_proof` with `"approved_for_use": true`. The AI never makes one up.
4. **Messaging.** Connect ManyChat or the Meta Instagram API ([docs/SETUP.md](docs/SETUP.md)).
5. **Purchases.** Connect Kajabi, Stripe, PayPal or Square webhooks so buyers stop getting sales messages.
6. **Run in draft mode for a while.** Review the drafts. When they consistently sound like you, set `SEND_MODE=auto`.

## Docs

- [docs/SETUP.md](docs/SETUP.md): environment, integrations, deployment, going live
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pipeline works and where the guardrails live
- `prompts/`: the versioned prompts, including Lee's voice guide (`prompts/brand-voice.md`)
