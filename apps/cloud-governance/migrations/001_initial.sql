CREATE TABLE IF NOT EXISTS cgov_policy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  canvas_id UUID,
  name TEXT NOT NULL,
  model JSONB NOT NULL,
  compiled_yaml TEXT,
  action_class TEXT NOT NULL DEFAULT 'none',
  enforcement TEXT NOT NULL DEFAULT 'observe',
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, name)
);
CREATE INDEX IF NOT EXISTS cgov_policy_customer_canvas_idx ON cgov_policy(customer_id, canvas_id);

CREATE TABLE IF NOT EXISTS cgov_policy_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  policy_id UUID NOT NULL REFERENCES cgov_policy(id) ON DELETE CASCADE,
  component_id UUID NOT NULL,
  account_ref TEXT,
  regions TEXT[] NOT NULL DEFAULT '{}',
  active_run_id UUID,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, component_id)
);
CREATE INDEX IF NOT EXISTS cgov_policy_account_customer_policy_idx ON cgov_policy_account(customer_id, policy_id);

CREATE TABLE IF NOT EXISTS cgov_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  policy_id UUID NOT NULL REFERENCES cgov_policy(id) ON DELETE CASCADE,
  policy_account_id UUID NOT NULL REFERENCES cgov_policy_account(id) ON DELETE CASCADE,
  component_id UUID NOT NULL,
  kind TEXT NOT NULL,
  enforcement TEXT NOT NULL,
  action_class TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  evaluation TEXT,
  counts JSONB NOT NULL DEFAULT '{}',
  message TEXT,
  command_payload JSONB,
  dispatched_at TIMESTAMPTZ,
  requested_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS cgov_run_customer_policy_idx ON cgov_run(customer_id, policy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cgov_run_customer_created_idx ON cgov_run(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cgov_run_dispatch_pending_idx ON cgov_run(dispatched_at)
  WHERE command_payload IS NOT NULL AND status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS cgov_run_match (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  run_id UUID NOT NULL REFERENCES cgov_run(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  arn TEXT,
  region TEXT NOT NULL,
  name TEXT,
  tags JSONB NOT NULL DEFAULT '{}',
  owner TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, resource_id)
);
CREATE INDEX IF NOT EXISTS cgov_run_match_customer_run_idx ON cgov_run_match(customer_id, run_id);

CREATE TABLE IF NOT EXISTS cgov_run_action (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  run_id UUID NOT NULL REFERENCES cgov_run(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  message TEXT,
  prior_state JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, resource_id, action)
);
CREATE INDEX IF NOT EXISTS cgov_run_action_customer_run_idx ON cgov_run_action(customer_id, run_id);

CREATE TABLE IF NOT EXISTS cgov_exception (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  canvas_id UUID,
  policy_name TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  approver TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, policy_name, resource_id)
);
CREATE INDEX IF NOT EXISTS cgov_exception_customer_policy_idx ON cgov_exception(customer_id, policy_name, expires_at);

CREATE TABLE IF NOT EXISTS cgov_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  canvas_id UUID,
  policy_name TEXT NOT NULL,
  cron TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  enforcement TEXT NOT NULL DEFAULT 'observe',
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, policy_name)
);
CREATE INDEX IF NOT EXISTS cgov_schedule_customer_enabled_idx ON cgov_schedule(customer_id, enabled, next_run_at);
