import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import {
  findClientByClientId,
  projectFromFields,
  projectFromLive,
  redirectUrisEqual,
  type KeycloakClientRep,
} from './_shared'

/**
 * Drift for clients: compare the fields we declare (name, protocol, enabled,
 * publicClient, standardFlowEnabled, redirectUris) against the live client in
 * Keycloak. Best-effort — a client that can't be matched (missing / transient
 * error) is skipped rather than raising false drift. Read-only:
 * GET /clients?clientId=<clientId>.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  for (const item of items) {
    const clientId = String(item.fields.clientId ?? '').trim()
    if (!clientId) continue

    let match: KeycloakClientRep | null
    try {
      const res = await admin.get(`/clients?clientId=${encodeURIComponent(clientId)}`)
      if (!res.ok) continue // best-effort: can't read, don't assert drift
      const list = parseJson<KeycloakClientRep[]>(res.body) ?? []
      match = findClientByClientId(list, clientId)
    } catch {
      continue
    }
    if (!match) continue

    const expected = projectFromFields(item.fields)
    const actual = projectFromLive(match)

    const scalarFields: Array<keyof typeof expected> = [
      'name',
      'protocol',
      'enabled',
      'publicClient',
      'standardFlowEnabled',
    ]
    for (const field of scalarFields) {
      // Only assert name drift when we actually declare a name.
      if (field === 'name' && !expected.name) continue
      if (expected[field] !== actual[field]) {
        diffs.push({
          field: `${clientId}.${String(field)}`,
          expected: expected[field],
          actual: actual[field],
          severity: 'warning',
        })
      }
    }

    if (!redirectUrisEqual(expected.redirectUris, actual.redirectUris)) {
      diffs.push({
        field: `${clientId}.redirectUris`,
        expected: expected.redirectUris,
        actual: actual.redirectUris,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
