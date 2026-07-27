-- 001_init (down) — drops exactly what the up migration created, child tables first.

DROP INDEX IF EXISTS idx_attempt_scope_channel;
DROP INDEX IF EXISTS idx_attempt_propagation;
DROP INDEX IF EXISTS idx_propagation_idempotency;
DROP INDEX IF EXISTS idx_propagation_booking;
DROP INDEX IF EXISTS idx_propagation_scope;
DROP INDEX IF EXISTS idx_booking_source_identity;
DROP INDEX IF EXISTS idx_booking_scope;
DROP INDEX IF EXISTS idx_connection_scope;
DROP INDEX IF EXISTS idx_property_tenant;

DROP TABLE IF EXISTS ingest_event;
DROP TABLE IF EXISTS propagation_attempt;
DROP TABLE IF EXISTS propagation;
DROP TABLE IF EXISTS booking;
DROP TABLE IF EXISTS channel_connection;
DROP TABLE IF EXISTS property;
DROP TABLE IF EXISTS tenant;
