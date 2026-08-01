// Shared helpers for the Orca Business Units config type (deploy + rollback + drift).
//
// Orca business units are "filters" in the REST API — the same resource Orca's
// Terraform provider `orcasecurity_business_unit` writes:
//   POST   /api/filters          create; returns { data: { filter_id, ... } }
//   GET    /api/filters/{id}      read;   returns { data: { ... } }
//   PUT    /api/filters/{id}      update
//   DELETE /api/filters/{id}      delete
// (VERIFIED against terraform-provider-orcasecurity api_client/business_unit.go.)
//
// A business unit scopes findings to a set of resources selected by ONE filter
// type (a BU cannot mix filter types — per the provider docs). We model that as
// a filter-type select plus a value list, mapped to the single JSON key the API
// expects. `name` is the human identity; the server `filter_id` is tracked in
// rollbackData (see lib/reconcile.ts).

import {
  normalizeBool,
  normalizeStringList,
  type ReconcileData,
  type ReconcileEntry,
} from '../../lib/reconcile'

/** Valid Orca business-unit criticality values (mirror canvas.yaml). */
export const CRITICALITIES = new Set<string>(['low', 'medium', 'high', 'critical'])

/**
 * Canvas filter-type value -> the single JSON key the Orca filter API expects.
 * Mirrors the mapping in the provider's api_client/business_unit.go struct tags.
 */
export const BU_FILTER_JSON_KEY: Record<string, string> = {
  cloud_providers: 'cloud_provider',
  cloud_vendor_id: 'cloud_vendor_id',
  custom_tags: 'custom_tags',
  cloud_tags: 'inventory_tags',
  cloud_account_tags: 'account_tags_info_list',
}

/** Every JSON key a business-unit filter can carry (for drift read-back). */
export const BU_FILTER_JSON_KEYS = Object.values(BU_FILTER_JSON_KEY)

/** One Orca business unit (the `data` payload of /api/filters responses). */
export interface OrcaBusinessUnit {
  filter_id?: string
  name?: string
  filter_data?: Record<string, string[]>
  shiftleft_filter_data?: Record<string, string[]>
  global_filter?: boolean
  business_criticality?: string
  owner_team?: string
  application?: string
  contact_emails?: string[]
  deployment_stages?: string[]
  [key: string]: unknown
}

export type BusinessUnitRollbackEntry = ReconcileEntry<OrcaBusinessUnit>
export type BusinessUnitRollbackData = ReconcileData<OrcaBusinessUnit>

/**
 * Build the Orca filter body from canvas fields (POST/PUT payload). Metadata
 * fields are sent unconditionally (matching the provider) so an update can clear
 * a value; the scope filter is sent only when a filter type + values are given
 * (a business unit with no filter is org-wide / global).
 */
export function buildBusinessUnitBody(fields: Record<string, unknown>): OrcaBusinessUnit {
  const body: OrcaBusinessUnit = {
    name: String(fields.name ?? '').trim(),
    business_criticality: String(fields.businessCriticality ?? '').trim(),
    owner_team: String(fields.ownerTeam ?? '').trim(),
    application: String(fields.application ?? '').trim(),
    contact_emails: normalizeStringList(fields.contactEmails),
    deployment_stages: normalizeStringList(fields.deploymentStages),
  }

  const filterType = String(fields.filterType ?? '').trim()
  const jsonKey = BU_FILTER_JSON_KEY[filterType]
  const filterValues = normalizeStringList(fields.filterValues)
  if (jsonKey && filterValues.length > 0) {
    body.filter_data = { [jsonKey]: filterValues }
  } else if (normalizeBool(fields.global, false)) {
    // No scope filter -> an explicit org-wide (global) business unit.
    body.global_filter = true
  }

  return body
}

/** The chosen filter type's value list from a live/expected business unit, or []. */
export function filterValuesOf(bu: OrcaBusinessUnit | null | undefined): string[] {
  if (!bu?.filter_data || typeof bu.filter_data !== 'object') return []
  for (const key of BU_FILTER_JSON_KEYS) {
    const values = bu.filter_data[key]
    if (Array.isArray(values) && values.length > 0) return values.map((v) => String(v))
  }
  return []
}
