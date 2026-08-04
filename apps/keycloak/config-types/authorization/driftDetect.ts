import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, type KeycloakAdminClient } from '../../lib/keycloakApi'
import { readString, readStringArray, stringSetsEqual } from '../../lib/fields'
import { resolveClientByClientId } from '../../lib/clients'
import {
  fetchPermissionByName,
  fetchResourceByName,
  fetchRolePolicyByName,
  fetchScopeByName,
  isAuthorizationEnabled,
  parseRoleEntriesField,
  projectScopeFields,
  resolvePolicyByName,
  resolveResourceByName,
  resolveRoleRef,
  resolveScopeByName,
  roleRefSetsEqual,
  type AuthorizationKind,
  type KeycloakNamedRef,
  type KeycloakPolicyRoleRef,
} from './_shared'

/**
 * Drift for authorization objects: compare the fields we declare against the
 * live object in Keycloak, per kind. Best-effort throughout — a client that
 * cannot be resolved, a client without authorization enabled, an item whose
 * own object cannot be found, or a declared reference (scope/resource/
 * policy/role name) that cannot be resolved to an id, is SKIPPED rather than
 * raising false drift (this app's standing convention: "can't read, don't
 * assert drift"). Refs are resolved to ids the same way deploy.ts does and
 * compared as ID SETS — live ids are never reverse-resolved back to names.
 *
 * Per the task scope for this pass: resource compares `uris` and the resolved
 * `scopes` id set; permission compares the resolved `policies`/`resources`/
 * `scopes` id sets plus `decisionStrategy`; role-policy compares the resolved
 * role-id set (with each entry's `required` flag) plus `decisionStrategy` and
 * `logic`. `scope` has no ref resolution to do, so its own displayName/iconUri
 * are compared directly. Resource's `displayName`/`type`/`ownerManagedAccess`/
 * `attributes` and permission/role-policy's `description` are NOT compared —
 * a documented gap for a later pass (see the app README's Coverage section).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })
  const clientUuidCache = new Map<string, string | null>()
  const authzEnabledCache = new Map<string, boolean>()

  for (const item of items) {
    const clientId = readString(item.fields.clientId)
    const kind = readString(item.fields.kind) as AuthorizationKind
    const name = readString(item.fields.name)
    if (!clientId || !kind || !name) continue

    const label = `${clientId}/${kind}/${name}`

    let cachedClientUuid = clientUuidCache.get(clientId)
    if (cachedClientUuid === undefined) {
      try {
        const client = await resolveClientByClientId(admin, clientId)
        cachedClientUuid = client?.id ?? null
      } catch {
        cachedClientUuid = null
      }
      clientUuidCache.set(clientId, cachedClientUuid)
    }
    if (!cachedClientUuid) continue // best-effort: client missing, don't assert drift
    // Bound to a `const` (rather than the `let` above) so TS narrows it to a
    // plain `string` inside the nested `resolveIds` closure below.
    const clientUuid: string = cachedClientUuid

    if (!authzEnabledCache.has(clientUuid)) {
      try {
        authzEnabledCache.set(clientUuid, await isAuthorizationEnabled(admin, clientUuid))
      } catch {
        authzEnabledCache.set(clientUuid, false)
      }
    }
    if (!authzEnabledCache.get(clientUuid)) continue // best-effort: authz not enabled, don't assert drift

    try {
      if (kind === 'resource') {
        const live = await fetchResourceByName(admin, clientUuid, name)
        if (!live) continue

        const scopeNames = readStringArray(item.fields.scopes)
        const expectedScopeIds: string[] = []
        let resolvable = true
        for (const scopeName of scopeNames) {
          const ref = await resolveScopeByName(admin, clientUuid, scopeName)
          if (!ref?.id) {
            resolvable = false
            break
          }
          expectedScopeIds.push(ref.id)
        }
        if (!resolvable) continue // best-effort: can't resolve a declared scope, don't assert drift

        const expectedUris = readStringArray(item.fields.uris)
        const actualUris = Array.isArray(live.uris) ? live.uris.map(String) : []
        if (!stringSetsEqual(expectedUris, actualUris)) {
          diffs.push({ field: `${label}.uris`, expected: expectedUris, actual: actualUris, severity: 'warning' })
        }

        const actualScopeIds = Array.isArray(live.scopes)
          ? live.scopes.map((ref) => String(ref.id ?? '')).filter(Boolean)
          : []
        if (!stringSetsEqual(expectedScopeIds, actualScopeIds)) {
          diffs.push({ field: `${label}.scopes`, expected: expectedScopeIds, actual: actualScopeIds, severity: 'warning' })
        }
        continue
      }

      if (kind === 'scope') {
        const live = await fetchScopeByName(admin, clientUuid, name)
        if (!live) continue

        const expected = projectScopeFields(item.fields)
        if (expected.displayName !== undefined && expected.displayName !== (live.displayName ?? undefined)) {
          diffs.push({
            field: `${label}.displayName`,
            expected: expected.displayName,
            actual: live.displayName,
            severity: 'warning',
          })
        }
        if (expected.iconUri !== undefined && expected.iconUri !== (live.iconUri ?? undefined)) {
          diffs.push({ field: `${label}.iconUri`, expected: expected.iconUri, actual: live.iconUri, severity: 'warning' })
        }
        continue
      }

      if (kind === 'permission') {
        const live = await fetchPermissionByName(admin, clientUuid, name)
        if (!live) continue

        const permissionType = readString(item.fields.permissionType) || 'resource'
        let resolvable = true

        const resolveIds = async (
          names: string[],
          resolver: (admin: KeycloakAdminClient, clientUuid: string, name: string) => Promise<KeycloakNamedRef | null>,
        ): Promise<string[]> => {
          const ids: string[] = []
          for (const n of names) {
            const ref = await resolver(admin, clientUuid, n)
            if (!ref?.id) {
              resolvable = false
              break
            }
            ids.push(ref.id)
          }
          return ids
        }

        const expectedPolicyIds = await resolveIds(readStringArray(item.fields.policies), resolvePolicyByName)
        if (!resolvable) continue
        const expectedScopeIds = await resolveIds(readStringArray(item.fields.scopes), resolveScopeByName)
        if (!resolvable) continue
        const expectedResourceIds =
          permissionType === 'resource'
            ? await resolveIds(readStringArray(item.fields.resources), resolveResourceByName)
            : []
        if (!resolvable) continue

        const actualPolicyIds = Array.isArray(live.policies) ? live.policies.map(String) : []
        if (!stringSetsEqual(expectedPolicyIds, actualPolicyIds)) {
          diffs.push({ field: `${label}.policies`, expected: expectedPolicyIds, actual: actualPolicyIds, severity: 'warning' })
        }

        const actualScopeIds = Array.isArray(live.scopes) ? live.scopes.map(String) : []
        if (!stringSetsEqual(expectedScopeIds, actualScopeIds)) {
          diffs.push({ field: `${label}.scopes`, expected: expectedScopeIds, actual: actualScopeIds, severity: 'warning' })
        }

        if (permissionType === 'resource') {
          const actualResourceIds = Array.isArray(live.resources) ? live.resources.map(String) : []
          if (!stringSetsEqual(expectedResourceIds, actualResourceIds)) {
            diffs.push({
              field: `${label}.resources`,
              expected: expectedResourceIds,
              actual: actualResourceIds,
              severity: 'warning',
            })
          }
        }

        const expectedDecision = readString(item.fields.decisionStrategy) || 'UNANIMOUS'
        const actualDecision = readString(live.decisionStrategy)
        if (expectedDecision !== actualDecision) {
          diffs.push({
            field: `${label}.decisionStrategy`,
            expected: expectedDecision,
            actual: actualDecision,
            severity: 'warning',
          })
        }
        continue
      }

      if (kind === 'role-policy') {
        const live = await fetchRolePolicyByName(admin, clientUuid, name)
        if (!live) continue

        const { entries, error } = parseRoleEntriesField(item.fields.roles)
        if (error || !entries) continue // can't determine the declared role set, don't assert drift

        const expectedRoles: KeycloakPolicyRoleRef[] = []
        let resolvable = true
        for (const entry of entries) {
          const ref = await resolveRoleRef(admin, entry)
          if (!ref?.id) {
            resolvable = false
            break
          }
          expectedRoles.push(ref)
        }
        if (!resolvable) continue

        const actualRoles = Array.isArray(live.roles) ? live.roles : []
        if (!roleRefSetsEqual(expectedRoles, actualRoles)) {
          diffs.push({ field: `${label}.roles`, expected: expectedRoles, actual: actualRoles, severity: 'warning' })
        }

        const expectedDecision = readString(item.fields.decisionStrategy) || 'UNANIMOUS'
        const actualDecision = readString(live.decisionStrategy)
        if (expectedDecision !== actualDecision) {
          diffs.push({
            field: `${label}.decisionStrategy`,
            expected: expectedDecision,
            actual: actualDecision,
            severity: 'warning',
          })
        }

        const expectedLogic = readString(item.fields.logic) || 'POSITIVE'
        const actualLogic = readString(live.logic)
        if (expectedLogic !== actualLogic) {
          diffs.push({ field: `${label}.logic`, expected: expectedLogic, actual: actualLogic, severity: 'warning' })
        }
      }
    } catch {
      continue // best-effort: any unexpected error reading this item, don't assert drift
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
