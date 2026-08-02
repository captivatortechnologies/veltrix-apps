// =============================================================================
// Shared types + helpers for the JFrog Xray Watches config type.
// Pure and network-free so validate.ts, deploy.ts, driftDetect.ts and the tests
// all read a canvas item and build an Xray watch body the same way.
//
// A canvas item = one Xray Watch = a scope (typed: all-repos or one named
// repository, plus a JSON escape valve for build/release-bundle/project/git
// resources or multiple resources at once) and a set of assigned policies
// (referenced by NAME — this app's own security-policies / license-policies,
// or ones created directly in Xray).
//
// Schema verified against the JFrog Xray REST API v2 watches reference and
// JFrog's own Terraform provider (see config-types/watches/deploy.ts header
// for citations).
// =============================================================================

import type { CanvasItemSnapshot, CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { parseJsonArray, readBool, readOptionalString, readString, readStringArray } from '../../lib/fields'

/** Resource `type` values Xray's Watches API accepts (verified — see deploy.ts citations). */
export const WATCH_RESOURCE_TYPES = [
  'repository',
  'build',
  'releaseBundle',
  'releaseBundleV2',
  'all-repos',
  'all-builds',
  'all-releaseBundles',
  'all-releaseBundlesV2',
  'all-projects',
  'project',
  'gitRepository',
] as const

/** Policy `type` values a watch's `assigned_policies` entry can carry. */
export const ASSIGNED_POLICY_TYPES = ['security', 'license', 'operational_risk'] as const

// --- Xray watch wire shapes ------------------------------------------------------

export interface XrayWatchFilter {
  type: string
  value: string
}

export interface XrayWatchResource {
  type: string
  name?: string
  bin_mgr_id?: string
  repo_type?: string
  filters?: XrayWatchFilter[]
  [extra: string]: unknown
}

export interface XrayAssignedPolicy {
  name: string
  type: 'security' | 'license' | 'operational_risk'
}

export interface XrayWatch {
  general_data: {
    /** Server-assigned, read-only — present on GET, never sent on write. */
    id?: string
    name: string
    description?: string
    active?: boolean
  }
  project_resources: {
    resources: XrayWatchResource[]
  }
  assigned_policies: XrayAssignedPolicy[]
  watch_recipients?: string[]
  create_ticket_enabled?: boolean
  ticket_profile?: string
}

// --- Canvas spec extraction ----------------------------------------------------

export interface WatchSpec {
  itemLabel: string
  name: string
  description?: string
  active: boolean
  resourceScope: string
  repositoryName?: string
  binMgrId?: string
  packageTypeFilters: string[]
  securityPolicyNames: string[]
  licensePolicyNames: string[]
  watchRecipients: string[]
  createTicketEnabled: boolean
  ticketProfile?: string
  resourcesJson: string
}

/** Read every canvas item as a `WatchSpec`. Tolerates the `items`/`sections` alias. */
export function extractWatchSpecs(canvas: CanvasSnapshot): WatchSpec[] {
  const items: CanvasItemSnapshot[] = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemLabel: item.name || readString(f.name) || '(unnamed)',
      name: readString(f.name),
      description: readOptionalString(f.description),
      active: readBool(f.active, true),
      resourceScope: readString(f.resource_scope) || 'all-repos',
      repositoryName: readOptionalString(f.repository_name),
      binMgrId: readOptionalString(f.bin_mgr_id),
      packageTypeFilters: readStringArray(f.package_type_filters),
      securityPolicyNames: readStringArray(f.security_policy_names),
      licensePolicyNames: readStringArray(f.license_policy_names),
      watchRecipients: readStringArray(f.watch_recipients),
      createTicketEnabled: readBool(f.create_ticket_enabled, false),
      ticketProfile: readOptionalString(f.ticket_profile),
      resourcesJson: typeof f.resources_json === 'string' ? f.resources_json : '',
    }
  })
}

/** The watch's logical identity: its name. Xray watch names are case-sensitive (they're a URL path segment). */
export function watchKey(name: string): string {
  return name.trim()
}

/** Find a live watch by name (exact match). */
export function findWatch(watches: XrayWatch[], name: string): XrayWatch | undefined {
  const key = watchKey(name)
  return watches.find((w) => watchKey(w.general_data?.name ?? '') === key)
}

/** Build the `project_resources.resources` array from the typed scope fields + the JSON escape valve. */
export function buildResources(spec: WatchSpec): XrayWatchResource[] {
  const resources: XrayWatchResource[] = []
  const filters: XrayWatchFilter[] = spec.packageTypeFilters.map((value) => ({ type: 'package-type', value }))

  if (spec.resourceScope === 'repository') {
    const resource: XrayWatchResource = { type: 'repository' }
    if (spec.repositoryName) resource.name = spec.repositoryName
    if (spec.binMgrId) resource.bin_mgr_id = spec.binMgrId
    if (filters.length > 0) resource.filters = filters
    resources.push(resource)
  } else {
    const resource: XrayWatchResource = { type: 'all-repos' }
    if (filters.length > 0) resource.filters = filters
    resources.push(resource)
  }

  const extra = parseJsonArray(spec.resourcesJson)
  if (extra.ok) {
    for (const entry of extra.value) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as { type?: unknown }).type === 'string') {
        resources.push(entry as XrayWatchResource)
      }
    }
  }
  return resources
}

/** Build the `assigned_policies` array from the typed security/license name lists. */
export function buildAssignedPolicies(spec: WatchSpec): XrayAssignedPolicy[] {
  return [
    ...spec.securityPolicyNames.map((name) => ({ name, type: 'security' as const })),
    ...spec.licensePolicyNames.map((name) => ({ name, type: 'license' as const })),
  ]
}

/** The full watch body sent on POST (create) / PUT (update). */
export function buildWatchBody(spec: WatchSpec): XrayWatch {
  const body: XrayWatch = {
    general_data: { name: spec.name, active: spec.active },
    project_resources: { resources: buildResources(spec) },
    assigned_policies: buildAssignedPolicies(spec),
  }
  if (spec.description) body.general_data.description = spec.description
  if (spec.watchRecipients.length > 0) body.watch_recipients = spec.watchRecipients
  if (spec.createTicketEnabled) {
    body.create_ticket_enabled = true
    if (spec.ticketProfile) body.ticket_profile = spec.ticketProfile
  }
  return body
}

/** Strip the read-only `general_data.id` before replaying a captured body on PUT (rollback restore). */
export function restorableWatchBody(prior: XrayWatch): XrayWatch {
  const { id, ...generalData } = prior.general_data
  return { ...prior, general_data: generalData }
}
