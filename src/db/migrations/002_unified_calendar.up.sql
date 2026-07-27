-- 002_unified_calendar (up) — canonical property availability and sync state.
-- Additive and compatible with the propagation-only baseline.

CREATE TABLE IF NOT EXISTS availability_record (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenant(id),
  property_id         TEXT NOT NULL REFERENCES property(id),
  booking_id          TEXT REFERENCES booking(id),
  source              TEXT NOT NULL,
  external_record_id  TEXT NOT NULL,
  record_kind         TEXT NOT NULL,
  lifecycle_state     TEXT NOT NULL,
  check_in            TEXT NOT NULL,
  check_out           TEXT NOT NULL,
  provider_event_id   TEXT NOT NULL,
  conflict_with_id    TEXT REFERENCES availability_record(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (tenant_id, property_id, source, external_record_id)
);

CREATE TABLE IF NOT EXISTS calendar_event (
  event_id               TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenant(id),
  property_id            TEXT NOT NULL REFERENCES property(id),
  payload_hash           TEXT NOT NULL,
  availability_record_id TEXT REFERENCES availability_record(id),
  outcome                TEXT NOT NULL,
  received_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS availability_sync (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenant(id),
  property_id            TEXT NOT NULL REFERENCES property(id),
  availability_record_id TEXT NOT NULL REFERENCES availability_record(id),
  operation              TEXT NOT NULL,
  idempotency_key        TEXT NOT NULL UNIQUE,
  nights                 TEXT NOT NULL,
  aggregate_status       TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS availability_sync_attempt (
  id              TEXT PRIMARY KEY,
  sync_id         TEXT NOT NULL REFERENCES availability_sync(id),
  tenant_id       TEXT NOT NULL REFERENCES tenant(id),
  property_id     TEXT NOT NULL REFERENCES property(id),
  channel         TEXT NOT NULL,
  status          TEXT NOT NULL,
  reason          TEXT,
  reason_code     TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  succeeded_at    TEXT,
  UNIQUE (sync_id, channel)
);

ALTER TABLE channel_connection ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE channel_connection ADD COLUMN last_attempt_at TEXT;
ALTER TABLE channel_connection ADD COLUMN last_successful_sync_at TEXT;
ALTER TABLE channel_connection ADD COLUMN last_sync_error TEXT;

CREATE INDEX IF NOT EXISTS idx_availability_calendar
  ON availability_record (tenant_id, property_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_availability_identity
  ON availability_record (tenant_id, property_id, source, external_record_id);
CREATE INDEX IF NOT EXISTS idx_availability_overlap
  ON availability_record (tenant_id, property_id, lifecycle_state, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_calendar_event_scope
  ON calendar_event (tenant_id, property_id, event_id);
CREATE INDEX IF NOT EXISTS idx_availability_sync_scope
  ON availability_sync (tenant_id, property_id, created_at);
CREATE INDEX IF NOT EXISTS idx_availability_sync_attempt_scope
  ON availability_sync_attempt (tenant_id, property_id, channel, status);
