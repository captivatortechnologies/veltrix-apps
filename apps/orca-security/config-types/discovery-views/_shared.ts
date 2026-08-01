// Shared helpers for the Orca Discovery Views config type (deploy + rollback + drift).
//
// Orca discovery views are saved "user preferences" — the same resource Orca's
// Terraform provider `orcasecurity_discovery_view` writes:
//   POST   /api/user_preferences        create; returns { data: { preference_id, ... } }
//   GET    /api/user_preferences/{id}    read;   returns { data: { ... } }
//   PUT    /api/user_preferences/{id}    update
//   DELETE /api/user_preferences/{id}    delete
// (VERIFIED against terraform-provider-orcasecurity api_client/discovery_view.go.)
//
// A discovery view saves a Discovery query (the Orca inventory query language)
// under `filter_data.query2`, optionally shared org-wide. `name` is the human
// identity; the server `preference_id` is tracked in rollbackData (see
// lib/reconcile.ts) — the API client reads/writes by that id, not by name.
//
// FLAG: view_type defaults to "discovery"; other view types exist in Orca but
// are unverified for this write path.

import {
  normalizeBool,
  type ReconcileData,
  type ReconcileEntry,
} from '../../lib/reconcile'

/** One Orca discovery view (the `data` payload of /api/user_preferences responses). */
export interface OrcaDiscoveryView {
  preference_id?: string
  name?: string
  filter_data?: { query2?: unknown }
  extra_params?: unknown
  organization_level?: boolean
  view_type?: string
  [key: string]: unknown
}

export type DiscoveryViewRollbackEntry = ReconcileEntry<OrcaDiscoveryView>
export type DiscoveryViewRollbackData = ReconcileData<OrcaDiscoveryView>

/**
 * Build the Orca discovery-view body from canvas fields plus the pre-parsed
 * Discovery query and extra params (parsing happens in validate/deploy so JSON
 * errors are reported cleanly). The query is nested under `filter_data.query2`,
 * matching the API.
 */
export function buildDiscoveryViewBody(
  fields: Record<string, unknown>,
  query: unknown,
  extraParams: unknown,
): OrcaDiscoveryView {
  const viewType = String(fields.viewType ?? '').trim() || 'discovery'
  return {
    name: String(fields.name ?? '').trim(),
    view_type: viewType,
    organization_level: normalizeBool(fields.organizationLevel, true),
    filter_data: { query2: query },
    extra_params: extraParams ?? {},
  }
}
