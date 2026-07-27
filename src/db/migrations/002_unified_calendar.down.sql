DROP INDEX IF EXISTS idx_availability_sync_attempt_scope;
DROP INDEX IF EXISTS idx_availability_sync_scope;
DROP INDEX IF EXISTS idx_calendar_event_scope;
DROP INDEX IF EXISTS idx_availability_overlap;
DROP INDEX IF EXISTS idx_availability_identity;
DROP INDEX IF EXISTS idx_availability_calendar;

DROP TABLE IF EXISTS availability_sync_attempt;
DROP TABLE IF EXISTS availability_sync;
DROP TABLE IF EXISTS calendar_event;
DROP TABLE IF EXISTS availability_record;

ALTER TABLE channel_connection DROP COLUMN last_sync_error;
ALTER TABLE channel_connection DROP COLUMN last_successful_sync_at;
ALTER TABLE channel_connection DROP COLUMN last_attempt_at;
ALTER TABLE channel_connection DROP COLUMN sync_status;
