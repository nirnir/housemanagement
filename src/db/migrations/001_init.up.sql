-- 001_init (up) — availability propagation baseline.
-- Additive only: creates new tables and indexes, alters nothing pre-existing.

CREATE TABLE IF NOT EXISTS tenant (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS property (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  name      TEXT NOT NULL,
  timezone  TEXT NOT NULL DEFAULT 'UTC'
);

CREATE TABLE IF NOT EXISTS channel_connection (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenant(id),
  property_id         TEXT NOT NULL REFERENCES property(id),
  channel             TEXT NOT NULL,
  external_listing_id TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  required            INTEGER NOT NULL DEFAULT 1,
  -- Name of the env var holding the secret. Never the secret itself.
  credential_ref      TEXT NOT NULL,
  UNIQUE (property_id, channel)
);

CREATE TABLE IF NOT EXISTS booking (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenant(id),
  property_id         TEXT NOT NULL REFERENCES property(id),
  source_channel      TEXT NOT NULL,
  external_booking_id TEXT NOT NULL,
  state               TEXT NOT NULL,
  check_in            TEXT NOT NULL,
  check_out           TEXT NOT NULL,
  received_at         TEXT NOT NULL,
  -- One booking per (tenant, source platform, external id).
  UNIQUE (tenant_id, source_channel, external_booking_id)
);

CREATE TABLE IF NOT EXISTS propagation (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenant(id),
  property_id     TEXT NOT NULL REFERENCES property(id),
  booking_id      TEXT NOT NULL REFERENCES booking(id),
  -- Convergence point for duplicate events, retries and replays.
  idempotency_key TEXT NOT NULL UNIQUE,
  derived_nights  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS propagation_attempt (
  id                  TEXT PRIMARY KEY,
  propagation_id      TEXT NOT NULL REFERENCES propagation(id),
  tenant_id           TEXT NOT NULL REFERENCES tenant(id),
  property_id         TEXT NOT NULL REFERENCES property(id),
  channel             TEXT NOT NULL,
  status              TEXT NOT NULL,
  reason              TEXT,
  reason_code         TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  submitted_nights    TEXT NOT NULL DEFAULT '[]',
  nights_fingerprint  TEXT,
  mapped_booking_type TEXT,
  first_attempted_at  TEXT,
  last_attempted_at   TEXT,
  accepted_at         TEXT,
  latency_ms          INTEGER,
  -- Exactly one attempt row per (propagation, channel): retries update in place.
  UNIQUE (propagation_id, channel)
);

-- Webhook delivery ledger: makes replayed deliveries observable and idempotent.
CREATE TABLE IF NOT EXISTS ingest_event (
  event_id     TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  booking_id   TEXT,
  outcome      TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

-- Indexes matching the actual query paths.
CREATE INDEX IF NOT EXISTS idx_property_tenant
  ON property (tenant_id);
CREATE INDEX IF NOT EXISTS idx_connection_scope
  ON channel_connection (tenant_id, property_id, enabled);
CREATE INDEX IF NOT EXISTS idx_booking_scope
  ON booking (tenant_id, property_id, state);
CREATE INDEX IF NOT EXISTS idx_booking_source_identity
  ON booking (tenant_id, source_channel, external_booking_id);
CREATE INDEX IF NOT EXISTS idx_propagation_scope
  ON propagation (tenant_id, property_id);
CREATE INDEX IF NOT EXISTS idx_propagation_booking
  ON propagation (booking_id);
CREATE INDEX IF NOT EXISTS idx_propagation_idempotency
  ON propagation (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_attempt_propagation
  ON propagation_attempt (propagation_id);
CREATE INDEX IF NOT EXISTS idx_attempt_scope_channel
  ON propagation_attempt (tenant_id, property_id, channel, status);
