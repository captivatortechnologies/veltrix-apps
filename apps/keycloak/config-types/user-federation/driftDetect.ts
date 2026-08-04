import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import { readString, stringMapsEqual } from '../../lib/fields'
import { findComponentByName, projectFromFields, projectFromLive, USER_STORAGE_PROVIDER_TYPE, type KeycloakComponentRep } from './_shared'

/**
 * Drift for user federation: compare providerId/enabled/priority and the
 * non-secret config keys this app manages against the live component in
 * Keycloak. bindCredential/keyTab are never compared — Keycloak returns them
 * masked as "**********", so a diff against that string would be
 * meaningless (see _shared.ts). Best-effort — a component that can't be
 * matched (or the realm id / list can't be read) is skipped rather than
 * raising false drift. Read-only: GET /admin/realms/{realm} (for the realm
 * id) and GET /components?parentId=&type=....
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  let components: KeycloakComponentRep[]
  try {
    const realmRes = await admin.get('')
    if (!realmRes.ok) return { hasDrift: false, diffs }
    const realmId = parseJson<{ id?: string }>(realmRes.body)?.id
    if (!realmId) return { hasDrift: false, diffs }

    const listRes = await admin.get(`/components?parentId=${encodeURIComponent(realmId)}&type=${encodeURIComponent(USER_STORAGE_PROVIDER_TYPE)}`)
    if (!listRes.ok) return { hasDrift: false, diffs }
    components = parseJson<KeycloakComponentRep[]>(listRes.body) ?? []
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = readString(item.fields.name)
    if (!name) continue

    const match = findComponentByName(components, name)
    if (!match) continue // best-effort: can't find it, don't assert drift

    const expected = projectFromFields(item.fields)
    const actual = projectFromLive(match)

    const scalarFields: Array<keyof typeof expected> = ['providerId', 'enabled', 'priority']
    for (const field of scalarFields) {
      if (expected[field] !== actual[field]) {
        diffs.push({
          field: `${name}.${String(field)}`,
          expected: expected[field],
          actual: actual[field],
          severity: 'warning',
        })
      }
    }

    if (!stringMapsEqual(expected.config, actual.config)) {
      diffs.push({
        field: `${name}.config`,
        expected: expected.config,
        actual: actual.config,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
