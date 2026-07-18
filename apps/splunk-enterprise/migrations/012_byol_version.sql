-- Splunk Enterprise App — BYOL Splunk version selection.
--
--   version_id: the id of the splunk_version catalog entry (system or
--     tenant-owned) selected for this infrastructure's deployment, chosen in
--     the New/Edit BYOL form (see the SDK's ByolInfrastructureManager
--     `versionOptions` prop). Stored as plain TEXT with no FK — a catalog
--     entry may be edited or removed without blocking on referential
--     integrity, matching this table's other loosely-coupled id references
--     (e.g. github_deployment_id). NULL means no version was selected; the
--     deploy route then omits `splunkDownloadUrl` and the worker uses its own
--     default installer.

ALTER TABLE splunk_byol_infrastructure
  ADD COLUMN IF NOT EXISTS version_id TEXT;
