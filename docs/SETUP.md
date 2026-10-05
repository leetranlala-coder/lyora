# Setup

## 1. Run it locally

Requires Node 22.13 or newer.

```bash
npm install
cp .env.example .env     # set ADMIN_PASSWORD at minimum
npm test
npm run seed
npm run dev              # http://localhost:3000/admin  (user: lee, password: ADMIN_PASSWORD)
npm run simulate         # chat with the agent in the terminal (separate database, nothing is sent)
```

With no `ANTHROPIC_API_KEY`, everything runs on an offline mock. That's useful for checking the plumbing, but the replies are canned. Add a key to see real ones.

## 2. Products, stock and testimonials (`config/products.json`)

This file is the only place the AI gets prices, payment plans, inclusions, links, stock and testimonials from. The first version was filled in from the Kajabi offers that existed on 5 Oct 2026, and **every product is inactive** until you check it.

For each product:

- `price`: leave it `null` if you're not sure. A product with no price is never sold; those leads come to you.
- `payment_plan_description`: written exactly as the AI should say it (e.g. `"9 weekly payments of $50"`). The AI copies it word for word and never invents terms.
- `includes`: only list what's genuinely in the product. The AI can't mention features that aren't here.
- `checkout_url` / `payment_plan_checkout_url`: needed for the AI to send an enrolment link.
- `booking_url`: needed for the AI to offer a call (or set `DEFAULT_BOOKING_URL`).
- `external_ids.kajabi_offer_id` / `stripe_price_id`: how purchases are matched to products.
- set `"active": true` when it's right, then run `npm run seed` (safe to re-run).

**Kit stock:** set `stock_status`. The AI will only say anything about shipping times once `fulfilment_days` is set, `shipping_enabled` is true and `fulfilment_verified` is true. Update this whenever your dispatch time changes.

**Testimonials:** only entries with `"approved_for_use": true` are ever used, and only as written. Only add real students, and only with their permission.

## 3. Connect Instagram

Use official integrations only. No scraping, and never your Instagram password.

### Option A: ManyChat (simplest if you already use it)

1. Set `MESSAGING_PROVIDER=manychat`, plus `MANYCHAT_API_KEY` (ManyChat → Settings → API) and a long random `MANYCHAT_WEBHOOK_SECRET`.
2. In ManyChat, add an **External Request** action to the flow that catches DMs (e.g. the Default Reply):
   - POST `https://<your-server>/webhooks/manychat`
   - header `X-Lyora-Secret: <MANYCHAT_WEBHOOK_SECRET>`
   - JSON body:
     ```json
     { "subscriber_id": "{{user_id}}", "username": "{{ig_username}}", "name": "{{full_name}}",
       "email": "{{email}}", "text": "{{last_input_text}}", "source": "default reply" }
     ```
3. Make sure ManyChat isn't also auto-replying in that flow, or leads will get two replies.
4. Before going live, check the field names and the sending endpoint (`/fb/sending/sendContent`) against ManyChat's current API docs.

ManyChat doesn't tell this system when you reply yourself in the Instagram app, so use **take over** in the dashboard when you jump into a conversation.

### Option B: Meta Instagram API (direct)

1. Create a Meta app with Instagram messaging, connect the LYORA Instagram professional account, and subscribe to `messages` (with echoes) webhooks.
2. Set `MESSAGING_PROVIDER=meta`, `META_APP_SECRET`, `META_VERIFY_TOKEN` (any string, entered in Meta too), `META_PAGE_ACCESS_TOKEN` and `META_IG_USER_ID`.
3. Webhook URL: `https://<your-server>/webhooks/instagram`.
4. Check `META_GRAPH_BASE_URL` (API version) against Meta's current docs.

With Meta, when you reply in the Instagram app, the AI pauses for that lead automatically (`AUTO_TAKEOVER_ON_HUMAN_REPLY`).

**Instagram's 24-hour rule:** automated messages can only be sent within 24 hours of the lead's last message. The system enforces this. Later follow-ups appear in your handoffs as "manual follow-up suggested".

## 4. Connect purchases

Each lets the system mark the lead as a customer, stop selling to her and track revenue.

| Provider | Endpoint | Secret | Notes |
|---|---|---|---|
| Kajabi | `/webhooks/kajabi` | `KAJABI_WEBHOOK_SECRET` (header `X-Lyora-Secret`) | send the JSON shape in `src/integrations/payments/kajabi.ts` from Zapier/Make ("Kajabi: new purchase"), or Kajabi's own webhook if your plan has it |
| Stripe | `/webhooks/stripe` | `STRIPE_WEBHOOK_SECRET` | events: `checkout.session.completed`, `charge.refunded`, `charge.dispute.created`. Put `product_id` / `instagram` in Checkout metadata |
| PayPal | `/webhooks/paypal` | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` | put our product id in the order `custom_id` |
| Square | `/webhooks/square` | `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL` | put `product:<id>` in the payment note |

Leads are matched by metadata, then email, then Instagram handle. Anything that can't be matched shows under **purchases → unmatched**, where you can match it with one click. You can also **mark purchased** from any lead page.

Tip: add an "Instagram handle" field to your Kajabi checkout so purchases match automatically.

## 5. Connect calls (optional)

- Set `DEFAULT_BOOKING_URL` (or `booking_url` on a product) so the AI can offer a call.
- For Calendly, add a webhook to `/webhooks/calendly` (events `invitee.created`, `invitee.canceled`), set `CALENDLY_WEBHOOK_SIGNING_KEY`, and add a booking question that mentions "Instagram" so bookings match the DM.
- Without a booking link, a lead who wants a call is handed to you.
- Google Calendar sync isn't implemented yet. Its push notifications need OAuth and a sync step, so use Calendly or mark calls booked from the dashboard.

## 6. Deploy

Any small always-on Node host works (Render, Railway, Fly.io, a VPS):

```bash
npm ci && npm run build && npm start
```

- Mount a persistent disk for `DATABASE_PATH` (SQLite). Back it up daily.
- Run **one** instance. Locking is safe across processes on the same disk, but one instance is simpler.
- To use the host's cron instead of the built-in 30-minute check, set `ENABLE_IN_PROCESS_SCHEDULER=false` and `INTERNAL_TICK_SECRET`, then POST `/internal/tick` with `Authorization: Bearer <secret>` every 30 minutes.
- Serve over HTTPS (webhooks require it) and keep `ADMIN_PASSWORD` strong.

## 7. Going live checklist

- [ ] products checked and activated, `npm run seed` shows no warnings you don't expect
- [ ] kit stock and fulfilment filled in (or left unverified, so the AI never mentions shipping)
- [ ] a few real, approved testimonials (optional)
- [ ] messaging connected; a test DM shows up in the dashboard
- [ ] purchase webhook connected; a test purchase marks the lead as a customer
- [ ] at least a week in **draft mode**, reviewing and editing drafts
- [ ] read some audit trails: are the decisions sensible?
- [ ] then `SEND_MODE=auto`. You can switch back at any time, and `AGENT_ENABLED=false` stops everything.

## Changing behaviour later

- **How often it checks:** `MESSAGE_CHECK_INTERVAL_MINUTES`
- **Follow-ups:** `MAX_AUTOMATED_FOLLOWUPS`, `FOLLOWUP_INTERVAL_HOURS`, `FOLLOWUP_SEND_START_HOUR` / `END_HOUR`
- **When very hot leads come to you:** `HIGH_TICKET_THRESHOLD`
- **Voice:** edit `prompts/brand-voice.md` and bump its `version`. Every message records which version wrote it.
- **Sales approach:** `prompts/sales-supervisor.md`. Rules that must always hold live in `src/agents/supervisor.ts`.
