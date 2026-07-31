-- Security Onion App — BYOL grid generic node-tier storage (app-owned).
--
-- The shared SDK `ByolInfrastructureManager` was generalized from Splunk's
-- fixed two-tier (indexer/search-head) model to an app-declared N-tier
-- topology. Security Onion declares two tiers onto its existing node knobs:
--   • indexer_count     -> tier 'search' (Elasticsearch data / search nodes)
--   • search_head_count -> tier 'heavy'  (heavy nodes)
--
-- `node_tiers` is the generic `[{ key, count, placement }]` array the SDK form
-- sends/reads; the legacy indexer_count/search_head_count/indexer_placement/
-- search_head_placement columns are KEPT for back-compat (existing readers,
-- e.g. lib/byolTopology.ts's resource-plan builder) and stay in sync with
-- node_tiers going forward. Backfills every existing row exactly once (rows
-- already migrated, or freshly seeded by the app, are left untouched).

ALTER TABLE so_byol_infrastructure ADD COLUMN IF NOT EXISTS node_tiers JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE so_byol_infrastructure
SET node_tiers = jsonb_build_array(
  jsonb_build_object('key','search','count',COALESCE(indexer_count,1),'placement',indexer_placement),
  jsonb_build_object('key','heavy','count',COALESCE(search_head_count,1),'placement',search_head_placement)
)
WHERE node_tiers = '[]'::jsonb;
