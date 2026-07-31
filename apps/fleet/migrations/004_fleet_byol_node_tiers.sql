-- Fleet App — BYOL generic node-tier storage (app-owned).
--
-- The SDK's ByolInfrastructureManager moved from a fixed Splunk-shaped
-- indexer/search-head pair to an app-declared N-tier topology. Fleet's two
-- legacy count columns map onto its own tiers — indexer_count -> "database"
-- (MySQL/MariaDB), search_head_count -> "server" (fleet-server) — so this adds
-- a single `node_tiers` JSONB column and backfills it from the existing
-- columns. The legacy indexer_count/search_head_count/indexer_placement/
-- search_head_placement columns are kept (still written) for
-- lib/byolTopology.ts, which is unchanged and continues to read them.

ALTER TABLE fleet_byol_infrastructure ADD COLUMN IF NOT EXISTS node_tiers JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE fleet_byol_infrastructure
SET node_tiers = jsonb_build_array(
  jsonb_build_object('key','database','count',COALESCE(indexer_count,1),'placement',indexer_placement),
  jsonb_build_object('key','server','count',COALESCE(search_head_count,1),'placement',search_head_placement)
)
WHERE node_tiers = '[]'::jsonb;
