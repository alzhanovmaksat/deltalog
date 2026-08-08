-- DeltaLog — D1 schema.
--
-- Two tables carry the product: `checks` is the evidence log (append-only, hash
-- chained, one row per attempt including failures) and `revisions` holds the page
-- content at each material change. Everything else is scaffolding.

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free',  -- free | team | compliance
  -- SHA-256 of the API token. The token itself is shown once at creation and never
  -- stored, so a database leak does not hand over working credentials.
  api_token_hash TEXT UNIQUE,
  -- Billing. `plan` is the only field the app reads for gating; the rest is for
  -- reconciling against Stripe. `last_billing_event_at` is the Stripe event timestamp
  -- that produced the current state, and it is what makes out-of-order webhook
  -- delivery safe to ignore.
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT,
  billing_status         TEXT,
  last_billing_event_at  INTEGER,
  created_at  TEXT NOT NULL
);

-- Webhook deduplication. Stripe delivers at least once, so an event id that is
-- already here has already been applied and must not be applied again.
CREATE TABLE IF NOT EXISTS stripe_events (
  id           TEXT PRIMARY KEY,
  received_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watches (
  id                        TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspaces(id),
  vendor                    TEXT NOT NULL,
  url                       TEXT NOT NULL,
  kind                      TEXT NOT NULL,   -- PageKind
  interval_minutes          INTEGER NOT NULL DEFAULT 1440,
  status                    TEXT NOT NULL DEFAULT 'healthy',
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  first_failure_at          TEXT,
  next_check_at             TEXT NOT NULL,
  false_positives_reported  INTEGER NOT NULL DEFAULT 0,
  noise_patterns            TEXT NOT NULL DEFAULT '[]',  -- JSON array of regex sources
  created_at                TEXT NOT NULL
);

-- The cron handler's only hot query: due watches, oldest first.
CREATE INDEX IF NOT EXISTS watches_due ON watches (next_check_at);
CREATE INDEX IF NOT EXISTS watches_by_workspace ON watches (workspace_id);

CREATE TABLE IF NOT EXISTS revisions (
  id             TEXT PRIMARY KEY,
  watch_id       TEXT NOT NULL REFERENCES watches(id),
  captured_at    TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  entities_json  TEXT NOT NULL DEFAULT '[]',
  clauses_json   TEXT NOT NULL DEFAULT '[]',
  r2_key         TEXT              -- raw HTML lives in R2; D1 keeps the structure
);

CREATE INDEX IF NOT EXISTS revisions_by_watch ON revisions (watch_id, captured_at DESC);

-- Append-only. Never UPDATE or DELETE a row here: the hash chain is what makes the
-- exported evidence verifiable, and an edited row breaks every hash after it.
CREATE TABLE IF NOT EXISTS checks (
  id            TEXT PRIMARY KEY,
  watch_id      TEXT NOT NULL REFERENCES watches(id),
  checked_at    TEXT NOT NULL,
  outcome       TEXT NOT NULL,   -- ok | blocked | not_found | timeout | error
  http_status   INTEGER,
  content_hash  TEXT,
  material      INTEGER NOT NULL DEFAULT 0,
  summary       TEXT NOT NULL,
  revision_id   TEXT REFERENCES revisions(id),
  prev_hash     TEXT,
  hash          TEXT NOT NULL,
  duration_ms   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS checks_by_watch ON checks (watch_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  watch_id      TEXT NOT NULL REFERENCES watches(id),
  kind          TEXT NOT NULL,   -- change | watch_broken | watch_relocated
  severity      TEXT NOT NULL,   -- high pages immediately, low waits for the digest
  summary       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  delivered_at  TEXT,
  -- Delivery is best-effort and separate from the evidence log: an alert that was
  -- never emailed still happened, still has a row, and still appears in the export.
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  delivery_error    TEXT,
  delivery_failed   INTEGER NOT NULL DEFAULT 0,  -- 1 = permanent, stop retrying
  suppressed_reason TEXT,
  -- The acknowledgement workflow: auditors want a named human's decision on record,
  -- not just the diff.
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  decision      TEXT,            -- accepted | escalated
  note          TEXT
);

-- The delivery sweep's hot query.
CREATE INDEX IF NOT EXISTS alerts_undelivered
  ON alerts (delivered_at, delivery_failed, severity, workspace_id);
-- Backs the 24h duplicate-suppression lookup.
CREATE INDEX IF NOT EXISTS alerts_by_watch ON alerts (watch_id, delivered_at DESC);

CREATE TABLE IF NOT EXISTS notification_settings (
  workspace_id       TEXT PRIMARY KEY REFERENCES workspaces(id),
  emails             TEXT NOT NULL DEFAULT '[]',   -- JSON array
  slack_webhook_url  TEXT,                          -- Team+ only; cleared when revoked
  digest_cadence     TEXT NOT NULL DEFAULT 'daily', -- daily | weekly | off
  digest_hour_utc    INTEGER NOT NULL DEFAULT 14,
  last_digest_at     TEXT
);

-- Who can sign in, and to which workspace. One row per person per workspace.
CREATE TABLE IF NOT EXISTS members (
  email        TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (email, workspace_id)
);

-- Single-use sign-in links. Only the SHA-256 of the token is stored, so a database
-- leak yields nothing redeemable. Rows are consumed by setting used_at, not deleted,
-- so a replayed link is provably a replay rather than an unknown token.
CREATE TABLE IF NOT EXISTS magic_links (
  token_hash   TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email        TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);

CREATE INDEX IF NOT EXISTS magic_links_expiry ON magic_links (expires_at);

-- Vendors in the directory we are NOT monitoring, and why. Written by
-- scripts/seed-directory.ts and published at /directory/unmonitored. Kept as data
-- rather than a comment in a migration so the public page can never drift from the
-- last real crawl.
CREATE TABLE IF NOT EXISTS directory_gaps (
  slug        TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,   -- GapReason
  detail      TEXT,
  checked_at  TEXT NOT NULL
);
