-- Splunk Enterprise App — activation (one-time credential handoff).
--
-- After a BYOL environment reaches "ready", the initiating admin receives a
-- single-use activation LINK (never a password). They click it, set their own
-- admin password, and it is relayed to Splunk over TLS. Veltrix never stores the
-- customer's chosen password; only the SHA-256 of the one-time token is kept.

-- One-time activation tokens. Only token_hash (SHA-256 of the token) is stored —
-- the token itself lives only in the emailed link. Single-use + short-lived.
CREATE TABLE IF NOT EXISTS splunk_activation_token (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       TEXT NOT NULL,
  infrastructure_id UUID NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  admin_user        TEXT NOT NULL DEFAULT 'admin',
  admin_email       TEXT NOT NULL,
  sh_url            TEXT,
  environment_name  TEXT,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | consumed
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_splunk_activation_hash  ON splunk_activation_token(token_hash);
CREATE INDEX IF NOT EXISTS idx_splunk_activation_infra ON splunk_activation_token(infrastructure_id);

-- Transactional email outbox. Apps have no direct email capability, so the
-- activation email is written here atomically with the token; a platform
-- notification worker drains status='pending' rows and sends them (the one
-- documented platform seam). Kept app-owned so delivery is reliable + retryable.
CREATE TABLE IF NOT EXISTS splunk_notification_outbox (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id TEXT NOT NULL,
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body_text   TEXT NOT NULL,
  body_html   TEXT,
  kind        TEXT NOT NULL DEFAULT 'activation',
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  attempts    INT  NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_splunk_outbox_status ON splunk_notification_outbox(status, created_at);
