-- =============================================================================
-- 20260101001900_notifications_engine
-- Phase 11 — Notifications.
--
-- Extends the general-purpose public.notifications table introduced in
-- Phase 10 (20260101001700) rather than replacing it — docs/07 requires:
--   lifecycle CREATED -> QUEUED -> SENT/FAILED -> RETRYING -> SENT/EXHAUSTED
--   deduplication; retry; delivery status; read status; audit; role/scope
--   validation.
--
-- No external delivery channel (email/SMS/push) is configured in this
-- environment (docs/22 ADR-019 explains the same class of limitation as
-- ADR-014's "no live scheduler"). "Delivery" here means durably persisting
-- the row plus a Supabase Realtime broadcast to the recipient's own
-- postgres_changes subscription (RLS-scoped, so a recipient can only ever
-- receive their own rows over Realtime) — which cannot fail short of the
-- INSERT itself failing (already a transaction abort, not a FAILED status).
-- RETRYING/FAILED/EXHAUSTED are therefore not dead states: they are the real
-- states a future external-channel Edge Function will drive via
-- cims.record_delivery_failure/cims.retry_notification, exercised end-to-end
-- by this migration's own pgTAP file against a simulated channel failure.
-- =============================================================================

alter type public.notification_status add value if not exists 'RETRYING' after 'FAILED';
alter type public.notification_status add value if not exists 'EXHAUSTED' after 'RETRYING';
