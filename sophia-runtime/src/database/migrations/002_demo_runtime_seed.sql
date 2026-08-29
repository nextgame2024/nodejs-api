INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.customers (
  customer_id,
  name,
  external_company_id,
  metadata
)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'Sophia Demo Customer',
  NULL,
  '{"seed": "phase_1_demo"}'::jsonb
)
ON CONFLICT (customer_id) DO NOTHING;

INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.devices (
  device_id,
  customer_id,
  store_id,
  name,
  device_type,
  metadata
)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'demo-store',
  'Phase 1 Laptop',
  'laptop',
  '{"seed": "phase_1_demo"}'::jsonb
)
ON CONFLICT (device_id) DO NOTHING;

INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.ai_configs (
  ai_config_id,
  customer_id,
  device_id,
  provider,
  model,
  voice,
  avatar_provider,
  avatar_id,
  store_id,
  enabled_tools
)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'openai-realtime',
  'gpt-4o-realtime-preview',
  'alloy',
  'simli',
  NULL,
  'demo-store',
  '["getInventory"]'::jsonb
)
ON CONFLICT (ai_config_id) DO NOTHING;
