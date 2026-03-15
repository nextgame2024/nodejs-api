-- Townplanner v2
-- DAMS State Transport layer tables (phase 1)
-- Run on the backend database:
--   psql "$DATABASE_URL" -f backend/scripts/sql/townplanner_dams_state_transport_tables.sql

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS qld_dams_state_transport_25m_railway_corridor (
  id bigserial PRIMARY KEY,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_25m_railway_corridor__geom_gist
  ON qld_dams_state_transport_25m_railway_corridor
  USING GIST (geom);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_25m_railway_corridor__props_gin
  ON qld_dams_state_transport_25m_railway_corridor
  USING GIN (properties);

CREATE TABLE IF NOT EXISTS qld_dams_state_transport_25m_state_controlled_road (
  id bigserial PRIMARY KEY,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_25m_state_controlled_road__geom_gist
  ON qld_dams_state_transport_25m_state_controlled_road
  USING GIST (geom);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_25m_state_controlled_road__props_gin
  ON qld_dams_state_transport_25m_state_controlled_road
  USING GIN (properties);

CREATE TABLE IF NOT EXISTS qld_dams_state_transport_25m_busway_corridor (
  id bigserial PRIMARY KEY,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_25m_busway_corridor__geom_gist
  ON qld_dams_state_transport_25m_busway_corridor
  USING GIST (geom);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_25m_busway_corridor__props_gin
  ON qld_dams_state_transport_25m_busway_corridor
  USING GIN (properties);

CREATE TABLE IF NOT EXISTS qld_dams_state_transport_25m_light_rail_corridor (
  id bigserial PRIMARY KEY,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_25m_light_rail_corridor__geom_gist
  ON qld_dams_state_transport_25m_light_rail_corridor
  USING GIST (geom);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_25m_light_rail_corridor__props_gin
  ON qld_dams_state_transport_25m_light_rail_corridor
  USING GIN (properties);

CREATE TABLE IF NOT EXISTS qld_dams_state_transport_future_busway_corridor (
  id bigserial PRIMARY KEY,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_future_busway_corridor__geom_gist
  ON qld_dams_state_transport_future_busway_corridor
  USING GIST (geom);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_future_busway_corridor__props_gin
  ON qld_dams_state_transport_future_busway_corridor
  USING GIN (properties);

CREATE TABLE IF NOT EXISTS qld_dams_state_transport_busway_corridor (
  id bigserial PRIMARY KEY,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_busway_corridor__geom_gist
  ON qld_dams_state_transport_busway_corridor
  USING GIST (geom);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_busway_corridor__props_gin
  ON qld_dams_state_transport_busway_corridor
  USING GIN (properties);

CREATE TABLE IF NOT EXISTS qld_dams_state_transport_future_light_rail_corridor (
  id bigserial PRIMARY KEY,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_future_light_rail_corridor__geom_gist
  ON qld_dams_state_transport_future_light_rail_corridor
  USING GIST (geom);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_future_light_rail_corridor__props_gin
  ON qld_dams_state_transport_future_light_rail_corridor
  USING GIN (properties);

CREATE TABLE IF NOT EXISTS qld_dams_state_transport_light_rail_corridor (
  id bigserial PRIMARY KEY,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_light_rail_corridor__geom_gist
  ON qld_dams_state_transport_light_rail_corridor
  USING GIST (geom);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_light_rail_corridor__props_gin
  ON qld_dams_state_transport_light_rail_corridor
  USING GIN (properties);

CREATE TABLE IF NOT EXISTS qld_dams_state_transport_state_controlled_road (
  id bigserial PRIMARY KEY,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_state_controlled_road__geom_gist
  ON qld_dams_state_transport_state_controlled_road
  USING GIST (geom);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_state_controlled_road__props_gin
  ON qld_dams_state_transport_state_controlled_road
  USING GIN (properties);

CREATE TABLE IF NOT EXISTS qld_dams_state_transport_future_state_controlled_road (
  id bigserial PRIMARY KEY,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_future_state_controlled_road__geom_gist
  ON qld_dams_state_transport_future_state_controlled_road
  USING GIST (geom);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_future_state_controlled_road__props_gin
  ON qld_dams_state_transport_future_state_controlled_road
  USING GIN (properties);

CREATE TABLE IF NOT EXISTS qld_dams_state_transport_future_railway_corridor (
  id bigserial PRIMARY KEY,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_future_railway_corridor__geom_gist
  ON qld_dams_state_transport_future_railway_corridor
  USING GIST (geom);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_future_railway_corridor__props_gin
  ON qld_dams_state_transport_future_railway_corridor
  USING GIN (properties);

CREATE TABLE IF NOT EXISTS qld_dams_state_transport_railway_corridor (
  id bigserial PRIMARY KEY,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_railway_corridor__geom_gist
  ON qld_dams_state_transport_railway_corridor
  USING GIST (geom);
CREATE INDEX IF NOT EXISTS qld_dams_state_transport_railway_corridor__props_gin
  ON qld_dams_state_transport_railway_corridor
  USING GIN (properties);
