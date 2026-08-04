// =============================================================================
// Shared "directoryScope" live picker + id-aware resolver for
// unifiedRoleAssignment.directoryScopeId and
// unifiedRoleEligibilityScheduleRequest.directoryScopeId — used by
// directory-role-assignments and pim-role-eligibility, the two config types
// that scope a privileged grant this way.
//
// Graph documents THREE directoryScopeId value patterns. For
// unifiedRoleAssignment they are confirmed on the CREATE operation page (the
// resource page itself only gives a generic description, not the patterns):
// https://learn.microsoft.com/graph/api/rbacapplication-post-roleassignments
//   - "/"                          tenant-wide (Example 1)
//   - "/administrativeUnits/{id}"  scoped to an administrative unit (Example 2)
//   - "/{application-objectID}"    scoped to a resource application (Example 3:
//     `"directoryScopeId": "/661e1310-bd76-4795-89a7-8f3c8f855bfc"`, captioned
//     "The object ID of the application registration is 661e1310-...") — this
//     is the application's OBJECT id, NOT its appId/client id, which is why
//     this module resolves against entraOptions' separate `applicationObjects`
//     source (value = object id) rather than the appId-keyed `applications`
//     source CA's app-targeting fields use.
// The PIM equivalent (unifiedRoleEligibilityScheduleRequest.directoryScopeId,
// and identically unifiedRoleAssignmentScheduleRequest) documents the "/" +
// administrative-unit pattern directly on its own resource page: "Use `/` for
// tenant-wide scope. Use appScopeId to limit the scope to an application
// only" (directoryScopeId is "for example, administrative units") —
// https://learn.microsoft.com/graph/api/resources/unifiedroleeligibilityschedulerequest.
// This app does not manage appScopeId (it targets entitlement-management
// catalogs, a different feature area) — directoryScopeId with "/" already
// satisfies Graph's "either appScopeId or directoryScopeId is required" rule.
// =============================================================================

import type { OptionItem, OptionsProviderContext } from '@veltrixsecops/app-sdk'
import type { GraphClient } from '../../lib/graph'
import entraOptions from './entraOptions'
import { buildAdministrativeUnitNameToId, buildApplicationObjectNameToId } from './nameMaps'

const TENANT_SCOPE: OptionItem = {
  value: '/',
  label: 'Tenant-wide (/)',
  description: 'Applies across the entire directory',
}

function matchesQuery(label: string, query: string): boolean {
  return !query || label.toLowerCase().includes(query.toLowerCase())
}

/** Live options for the merged "directoryScope" alias source. */
export async function directoryScopeOptions(ctx: OptionsProviderContext): Promise<OptionItem[]> {
  const [administrativeUnits, applications] = await Promise.all([
    entraOptions({ ...ctx, source: 'administrativeUnits' }),
    entraOptions({ ...ctx, source: 'applicationObjects' }),
  ])
  const query = (ctx.query ?? '').trim()
  const sentinel = matchesQuery(TENANT_SCOPE.label, query) ? [TENANT_SCOPE] : []
  const auScoped = administrativeUnits.map((o) => ({
    ...o,
    value: `/administrativeUnits/${o.value}`,
    label: `${o.label} (administrative unit)`,
  }))
  const appScoped = applications.map((o) => ({
    ...o,
    value: `/${o.value}`,
    label: `${o.label} (application)`,
  }))
  return [...sentinel, ...auScoped, ...appScoped]
}

export interface DirectoryScopeNameMaps {
  administrativeUnit: Map<string, string>
  application: Map<string, string>
}

/** Build both directoryScope name maps once per deploy/drift run. */
export async function buildDirectoryScopeNameMaps(client: GraphClient): Promise<DirectoryScopeNameMaps> {
  const [administrativeUnit, application] = await Promise.all([
    buildAdministrativeUnitNameToId(client),
    buildApplicationObjectNameToId(client),
  ])
  return { administrativeUnit, application }
}

/**
 * Resolve a directoryScopeId field's value. A value already starting with
 * "/" is Graph-shaped already — passed straight through unchanged, whether
 * it is the bare tenant sentinel, a picker-produced "/administrativeUnits/{id}"
 * or "/{application-objectID}", or a pre-picker hand-typed value already in
 * one of those shapes. A value NOT starting with "/" cannot be a valid
 * directoryScopeId on the wire (every documented pattern above is
 * slash-prefixed), so it is treated as a hand-typed DISPLAY NAME and resolved
 * against the administrative-unit map first, then the application map.
 */
export function resolveDirectoryScope(
  value: string,
  maps: DirectoryScopeNameMaps
): { scope: string; missing?: string } {
  const v = (value ?? '').trim()
  if (!v || v === '/') return { scope: '/' }
  if (v.startsWith('/')) return { scope: v }
  const lower = v.toLowerCase()
  const auId = maps.administrativeUnit.get(lower)
  if (auId) return { scope: `/administrativeUnits/${auId}` }
  const appId = maps.application.get(lower)
  if (appId) return { scope: `/${appId}` }
  return { scope: '', missing: v }
}
