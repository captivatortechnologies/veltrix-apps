-- BYOL infrastructure now starts life as 'not_started' — it has not been
-- deployed yet. The deploy route is what moves a record to 'provisioning'.
--
-- Additive and safe: only changes the column DEFAULT for future inserts. Existing
-- rows keep whatever status they already have. The create path also sets the
-- value explicitly (see lib/db/byol.ts createByol), so this default is a
-- belt-and-braces guard for any direct insert.

ALTER TABLE splunk_byol_infrastructure ALTER COLUMN status SET DEFAULT 'not_started';
