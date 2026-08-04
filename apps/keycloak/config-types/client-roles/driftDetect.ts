import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import { resolveClientByClientId } from '../../lib/clients'
import { projectFromFields, projectFromLive, type KeycloakClientRoleRep } from './_shared'

/**
 * Drift for client roles: compare the fields we declare (description, composite)
 * against the live role in Keycloak. Best-effort — a declared clientId that
 * doesn't resolve to a live client, or a role that can't be read (missing /
 * transient error), is skipped rather than raising false drift. Read-only:
 * GET /clients?clientId=<clientId>, GET /clients/{clientUuid}/roles/{role-name}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  for (const item of items) {
    const clientId = readString(item.fields.clientId)
    const name = readString(item.fields.name)
    if (!clientId || !name) continue

    let match: KeycloakClientRoleRep | null
    try {
      const client = await resolveClientByClientId(admin, clientId)
      if (!client || !client.id) continue // best-effort: can't resolve the client, don't assert drift
      const res = await admin.get(`/clients/${encodeURIComponent(client.id)}/roles/${encodeURIComponent(name)}`)
      if (!res.ok) continue // best-effort: can't read (incl. 404 = absent), don't assert drift
      match = parseJson<KeycloakClientRoleRep>(res.body)
    } catch {
      continue
    }
    if (!match) continue

    const expected = projectFromFields(item.fields)
    const actual = projectFromLive(match)
    const label = `${clientId}/${name}`

    // Only assert description drift when we actually declare a description.
    if (expected.description && expected.description !== actual.description) {
      diffs.push({ field: `${label}.description`, expected: expected.description, actual: actual.description, severity: 'warning' })
    }
    if (expected.composite !== actual.composite) {
      diffs.push({ field: `${label}.composite`, expected: expected.composite, actual: actual.composite, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
