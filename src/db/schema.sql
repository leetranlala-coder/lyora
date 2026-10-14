-- LYORA DM agent schema (SQLite). All timestamps are UTC ISO-8601 strings.
-- JSON columns hold arrays/objects serialised as text.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- leads / CRM
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,                 -- instagram | facebook | ...
  platform_user_id TEXT NOT NULL,         -- IGSID or ManyChat subscriber id
  username TEXT,
  display_name TEXT,
  email TEXT,
  phone TEXT,
  source TEXT,                            -- e.g. manychat_keyword, story_reply, ad
  status TEXT NOT NULL DEFAULT 'new',     -- new | engaged | qualified | offer_made | call_booked | purchased | not_interested | stopped | handoff
  lead_temperature TEXT NOT NULL DEFAULT 'cold',
  lead_score INTEGER NOT NULL DEFAULT 0,
  experience_level TEXT NOT NULL DEFAULT 'unknown',
  current_job TEXT,
  main_goal TEXT,
  pain_points TEXT NOT NULL DEFAULT '[]',
  objections TEXT NOT NULL DEFAULT '[]',
  budget_concern INTEGER NOT NULL DEFAULT 0,
  payment_plan_interest INTEGER NOT NULL DEFAULT 0,
  kit_needed INTEGER NOT NULL DEFAULT 0,
  kit_interest INTEGER NOT NULL DEFAULT 0,
  course_interest INTEGER NOT NULL DEFAULT 0,
  coaching_interest INTEGER NOT NULL DEFAULT 0,
  call_interest INTEGER NOT NULL DEFAULT 0,
  recommended_offer TEXT,                 -- product id
  ai_summary TEXT,
  analysis_json TEXT,                     -- latest full LeadAnalysis
  last_inbound_message_at TEXT,
  last_outbound_message_at TEXT,
  first_response_at TEXT,
  follow_up_due_at TEXT,
  follow_up_count INTEGER NOT NULL DEFAULT 0,
  automation_status TEXT NOT NULL DEFAULT 'active', -- active | stopped
  stop_reason TEXT,
  human_takeover INTEGER NOT NULL DEFAULT 0,
  human_takeover_at TEXT,
  handoff_required INTEGER NOT NULL DEFAULT 0,
  handoff_reason TEXT,
  handoff_priority TEXT,                  -- low | normal | high | urgent
  handoff_created_at TEXT,
  handoff_resolved_at TEXT,
  call_booked INTEGER NOT NULL DEFAULT 0,
  purchased INTEGER NOT NULL DEFAULT 0,
  customer_value REAL NOT NULL DEFAULT 0,
  needs_processing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_username ON leads(username);
CREATE INDEX IF NOT EXISTS idx_leads_needs_processing ON leads(needs_processing);

-- Raw conversation history. Never summarised away.
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  platform TEXT NOT NULL,
  platform_message_id TEXT,               -- provider id; unique per platform for idempotency
  direction TEXT NOT NULL,                -- inbound | outbound
  content TEXT NOT NULL,
  sender_type TEXT NOT NULL,              -- lead | ai | human | system
  ai_generated INTEGER NOT NULL DEFAULT 0,
  human_generated INTEGER NOT NULL DEFAULT 0,
  outbound_message_id TEXT,
  processed_at TEXT,                      -- inbound only: when the agent finished with it
  created_at TEXT NOT NULL,
  UNIQUE (platform, platform_message_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, created_at);

-- Facts extracted from the conversation, each tied to the message it came from.
CREATE TABLE IF NOT EXISTS lead_notes (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  source_message_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_lead ON lead_notes(lead_id);

-- Every offer the agent has put in front of a lead (to avoid repeating / re-selling).
CREATE TABLE IF NOT EXISTS offers_made (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  product_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ------------------------------------------------------- products / stock / proof
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                     -- course | kit | course_and_kit | coaching | training | mentorship | membership
  active INTEGER NOT NULL DEFAULT 0,
  price REAL,                             -- NULL = unknown -> agent must hand off
  currency TEXT NOT NULL DEFAULT 'AUD',
  payment_plan_available INTEGER NOT NULL DEFAULT 0,
  payment_plan_description TEXT,          -- exact wording, e.g. "9 weekly payments of $50"
  includes TEXT NOT NULL DEFAULT '[]',
  excludes TEXT NOT NULL DEFAULT '[]',
  checkout_url TEXT,
  payment_plan_checkout_url TEXT,
  booking_url TEXT,
  stock_required INTEGER NOT NULL DEFAULT 0,
  sku TEXT,                               -- links to stock table when stock_required
  external_ids TEXT NOT NULL DEFAULT '{}', -- {"kajabi_offer_id": "...", "stripe_price_id": "..."}
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock (
  sku TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  stock_quantity INTEGER,                 -- NULL = unknown
  stock_status TEXT NOT NULL DEFAULT 'unknown', -- in_stock | low_stock | out_of_stock | unknown
  fulfilment_days INTEGER,                -- business days to dispatch; NULL = unknown
  fulfilment_verified INTEGER NOT NULL DEFAULT 0, -- Lee has confirmed the fulfilment time is current
  shipping_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS social_proof (
  id TEXT PRIMARY KEY,
  student_name_or_alias TEXT NOT NULL,
  problem_before TEXT,
  result TEXT,
  quote TEXT,
  approved_for_use INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- Always-true facts about Lee / LYORA the AI may state (her story, policies). From config/products.json.
CREATE TABLE IF NOT EXISTS brand_facts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- ------------------------------------------------------------- outcomes
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id),      -- NULL until matched
  product_id TEXT,
  provider TEXT NOT NULL,                 -- stripe | paypal | kajabi | square | manual
  provider_transaction_id TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'AUD',
  status TEXT NOT NULL,                   -- paid | refunded | disputed | pending
  is_payment_plan INTEGER NOT NULL DEFAULT 0,
  customer_email TEXT,
  attribution TEXT,                       -- ai_assisted | human_assisted | unattributed
  purchased_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_transaction_id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id),
  provider TEXT NOT NULL,
  provider_booking_id TEXT NOT NULL,
  invitee_email TEXT,
  starts_at TEXT,
  status TEXT NOT NULL,                   -- booked | cancelled
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_booking_id)
);

-- ------------------------------------------------------- follow-ups / outbound
CREATE TABLE IF NOT EXISTS follow_ups (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  scheduled_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  context TEXT NOT NULL,                  -- what in the conversation this follow-up should reference
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,                   -- scheduled | cancelled | sent | skipped | completed
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON follow_ups(status, scheduled_at);

-- Every message the agent writes. In draft mode these wait for Lee to approve.
CREATE TABLE IF NOT EXISTS outbound_messages (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  batch_id TEXT NOT NULL,                 -- bubbles from one decision share a batch
  position INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,                   -- draft | queued | sent | failed | discarded
  idempotency_key TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL,                  -- reply | followup
  trigger_ref TEXT,
  decision_action TEXT,
  provider_message_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  edited_by_human INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_messages(status);

-- -------------------------------------------------- concurrency / idempotency
CREATE TABLE IF NOT EXISTS lead_locks (
  lead_id TEXT PRIMARY KEY,
  locked_by TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (provider, event_id)
);

-- ------------------------------------------------------------------ audit
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  lead_id TEXT,
  run_id TEXT,                            -- groups the stages of one pipeline run
  stage TEXT NOT NULL,                    -- analysis | supervisor | response | safety | send | followup | admin | webhook
  event TEXT NOT NULL,
  prompt_name TEXT,
  prompt_version TEXT,
  model TEXT,
  data_json TEXT,                         -- what was decided / retrieved / validated (no secrets)
  actor TEXT NOT NULL DEFAULT 'agent',    -- agent | human | system
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_lead ON audit_log(lead_id, created_at);
