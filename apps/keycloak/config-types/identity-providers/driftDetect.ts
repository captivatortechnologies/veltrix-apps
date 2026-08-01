import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import { readString, stringMapsEqual } from '../../lib/fields'
import { projectFromFields, projectFromLive, type KeycloakIdpRep } from './_shared'

/**
 * Drift for identity providers: compare the fields we declare (displayName,
 * providerId, enabled, config) against the live provider in Keycloak. Secret
 * config keys are excluded from the comparison (Keycloak returns them masked).
 * Best-effort — a provider that can't be read is skipped rather than raising false
 * drift. Read-only: GET /identity-provider/instances/{alias}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  for (const item of items) {
    const alias = readString(item.fields.alias)
    if (!alias) continue

    let match: KeycloakIdpRep | null
    try {
      const res = await admin.get(`/identity-provider/instances/${encodeURIComponent(alias)}`)
      if (!res.ok) continue // best-effort: can't read, don't assert drift
      match = parseJson<KeycloakIdpRep>(res.body)
    } catch {
      continue
    }
    if (!match) continue

    const expected = projectFromFields(item.fields)
    const actual = projectFromLive(match)

    const scalarFields: Array<keyof typeof expected> = ['displayName', 'providerId', 'enabled']
    for (const field of scalarFields) {
      // Only assert displayName drift when we actually declare one.
      if (field === 'displayName' && !expected.displayName) continue
      if (expected[field] !== actual[field]) {
        diffs.push({
          field: `${alias}.${String(field)}`,
          expected: expected[field],
          actual: actual[field],
          severity: 'warning',
        })
      }
    }

    if (!stringMapsEqual(expected.config, actual.config)) {
      diffs.push({
        field: `${alias}.config`,
        expected: expected.config,
        actual: actual.config,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
