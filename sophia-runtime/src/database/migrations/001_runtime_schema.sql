CREATE SCHEMA IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__;

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.customers (
  customer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  external_company_id text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_status_check CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.devices (
  device_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  store_id text,
  name text NOT NULL,
  device_type text NOT NULL DEFAULT 'laptop',
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_status_check CHECK (status IN ('active', 'inactive', 'maintenance')),
  CONSTRAINT devices_type_check CHECK (device_type IN ('laptop', 'kiosk', 'mini_pc', 'tablet', 'display'))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.ai_configs (
  ai_config_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  device_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.devices(device_id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  voice text,
  temperature numeric(4, 3),
  max_tokens integer,
  avatar_provider text NOT NULL,
  avatar_id text,
  store_id text,
  enabled_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  device_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.devices(device_id) ON DELETE SET NULL,
  ai_config_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.ai_configs(ai_config_id) ON DELETE SET NULL,
  store_id text,
  created_by_user_id text,
  ai_provider text NOT NULL,
  avatar_provider text NOT NULL,
  provider_session_id text,
  avatar_session_id text,
  status text NOT NULL DEFAULT 'created',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_status_check CHECK (status IN ('created', 'active', 'closed', 'failed'))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.tool_calls (
  tool_call_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  error_message text,
  provider_call_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_calls_status_check CHECK (status IN ('pending', 'succeeded', 'failed'))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id) ON DELETE CASCADE,
  customer_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  device_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.devices(device_id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sophia_runtime_devices_customer
  ON __SOPHIA_RUNTIME_SCHEMA__.devices(customer_id);

CREATE INDEX IF NOT EXISTS idx_sophia_runtime_ai_configs_customer_active
  ON __SOPHIA_RUNTIME_SCHEMA__.ai_configs(customer_id, active);

CREATE INDEX IF NOT EXISTS idx_sophia_runtime_sessions_customer_started
  ON __SOPHIA_RUNTIME_SCHEMA__.sessions(customer_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sophia_runtime_tool_calls_session
  ON __SOPHIA_RUNTIME_SCHEMA__.tool_calls(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sophia_runtime_events_session
  ON __SOPHIA_RUNTIME_SCHEMA__.events(session_id, created_at DESC);
