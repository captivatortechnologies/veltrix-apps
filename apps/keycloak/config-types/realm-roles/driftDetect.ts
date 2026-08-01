import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import { projectFromFields, projectFromLive, type KeycloakRoleRep } from './_shared'

/**
 * Drift for realm roles: compare the fields we declare (description, composite)
 * against the live role in Keycloak. Best-effort — a role that can't be read
 * (missing / transient error) is skipped rather than raising false drift.
 * Read-only: GET /roles/{role-name}.
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

    let match: KeycloakRoleRep | null
    try {
      const res = await admin.get(`/roles/${encodeURIComponent(name)}`)
      if (!res.ok) continue // best-effort: can't read, don't assert drift
      match = parseJson<KeycloakRoleRep>(res.body)
    } catch {
      continue
    }
    if (!match) continue

    const expected = projectFromFields(item.fields)
    const actual = projectFromLive(match)

    // Only assert description drift when we actually declare a description.
    if (expected.description && expected.description !== actual.description) {
      diffs.push({
        field: `${name}.description`,
        expected: expected.description,
        actual: actual.description,
        severity: 'warning',
      })
    }
    if (expected.composite !== actual.composite) {
      diffs.push({
        field: `${name}.composite`,
        expected: expected.composite,
        actual: actual.composite,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
