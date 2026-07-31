-- MISP App — generic N-tier BYOL node storage (app-owned).
--
-- Replaces the SDK's hardcoded Splunk-shaped indexer/search-head pair with a
-- generic per-app tier list. MISP's two user-scalable tiers map 1:1 onto the
-- existing columns:
--   • database (MariaDB nodes)   ← indexer_count / indexer_placement
--   • core (MISP core web/API)   ← search_head_count / search_head_placement
--
-- The legacy columns are kept (and stay the source of truth for
-- lib/byolTopology.ts's resource plan) during this transition; `node_tiers` is
-- the new generic read path the SDK's <ByolInfrastructureManager> consumes via
-- `ByolInfrastructure.tiers`. Backfilled once, in display order [database, core].

ALTER TABLE misp_byol_infrastructure ADD COLUMN IF NOT EXISTS node_tiers JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE misp_byol_infrastructure
SET node_tiers = jsonb_build_array(
  jsonb_build_object('key','database','count',COALESCE(indexer_count,1),'placement',indexer_placement),
  jsonb_build_object('key','core','count',COALESCE(search_head_count,1),'placement',search_head_placement)
)
WHERE node_tiers = '[]'::jsonb;
