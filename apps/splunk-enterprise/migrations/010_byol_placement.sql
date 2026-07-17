-- Splunk Enterprise App — BYOL topology authoring: cluster placement,
-- control-plane consolidation, and configurable heavy forwarders.
--
--   control_plane_layout: dedicated | consolidated | single — how many
--     instances the management roles run on (cost vs isolation, distributed only).
--   heavy_forwarder_count: number of heavy forwarders in the ingest tier
--     (distributed only; defaults to 1, was previously a hardcoded 2).
--   indexer_placement / search_head_placement: JSONB describing how the cluster's
--     nodes are spread across sites — { mode, granularity, sites: [{ site, percent }] }.
--     NULL means single-site (all nodes in the main region). Only these two tiers
--     support multi-site placement; every other tier is always main-region.

ALTER TABLE splunk_byol_infrastructure
  ADD COLUMN IF NOT EXISTS control_plane_layout TEXT NOT NULL DEFAULT 'dedicated',
  ADD COLUMN IF NOT EXISTS heavy_forwarder_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS indexer_placement JSONB,
  ADD COLUMN IF NOT EXISTS search_head_placement JSONB;
