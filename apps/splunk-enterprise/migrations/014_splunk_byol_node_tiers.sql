-- Splunk Enterprise app — BYOL generic N-tier node storage.
--
-- The SDK's ByolInfrastructureManager moved from a fixed Splunk-shaped
-- indexer/search-head pair to an app-declared topology of 1..N named tiers
-- (see @veltrixsecops/app-sdk/byol ByolTopology / ByolTierValue). Splunk keeps
-- its original two tiers — 'indexer' (indexer cluster peers) and 'searchHead'
-- (search head cluster members) — persisted here as a single JSONB array so
-- the app-agnostic form/table can round-trip an arbitrary tier list without a
-- bespoke column per tier.
--
--   node_tiers: [{ key, count, placement }], in display order
--     [indexer, searchHead]. Backfilled from the existing indexer_count/
--     search_head_count/indexer_placement/search_head_placement columns,
--     which are KEPT (not dropped) for back-compat with any code still
--     reading the legacy shape (mirrors the SDK's ByolInfrastructure
--     @deprecated fields), including the LIVE production infrastructure row.

ALTER TABLE splunk_byol_infrastructure ADD COLUMN IF NOT EXISTS node_tiers JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE splunk_byol_infrastructure
SET node_tiers = jsonb_build_array(
  jsonb_build_object('key','indexer','count',COALESCE(indexer_count,1),'placement',indexer_placement),
  jsonb_build_object('key','searchHead','count',COALESCE(search_head_count,1),'placement',search_head_placement)
)
WHERE node_tiers = '[]'::jsonb;
