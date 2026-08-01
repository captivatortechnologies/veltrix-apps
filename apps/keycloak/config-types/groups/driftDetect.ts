import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import { readString, stringMapsEqual, stringSetsEqual } from '../../lib/fields'
import {
  fetchGroupRealmRoleNames,
  findGroupByName,
  projectAttributesFromLive,
  projectFromFields,
  type KeycloakGroupRep,
} from './_shared'

/**
 * Drift for groups: compare the fields we declare (attributes, realmRoles) against
 * the live top-level group in Keycloak. Best-effort — a group that can't be matched
 * (missing / transient error) is skipped rather than raising false drift. Read-only:
 * GET /groups?search=<name> and GET /groups/{id}/role-mappings/realm.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  for (const item of items) {
    const name = readString(item.fields.name)
    if (!name) continue

    let match: KeycloakGroupRep | null
    try {
      const res = await admin.get(`/groups?search=${encodeURIComponent(name)}`)
      if (!res.ok) continue // best-effort: can't read, don't assert drift
      const list = parseJson<KeycloakGroupRep[]>(res.body) ?? []
      match = findGroupByName(list, name)
    } catch {
      continue
    }
    if (!match || !match.id) continue

    const expected = projectFromFields(item.fields)
    const actualAttributes = projectAttributesFromLive(match)

    if (!stringMapsEqual(expected.attributes, actualAttributes)) {
      diffs.push({
        field: `${name}.attributes`,
        expected: expected.attributes,
        actual: actualAttributes,
        severity: 'warning',
      })
    }

    let actualRoles: string[]
    try {
      actualRoles = await fetchGroupRealmRoleNames(admin, match.id)
    } catch {
      continue // couldn't read role mappings — don't assert drift on them
    }
    if (!stringSetsEqual(expected.realmRoles, actualRoles)) {
      diffs.push({
        field: `${name}.realmRoles`,
        expected: expected.realmRoles,
        actual: actualRoles,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
