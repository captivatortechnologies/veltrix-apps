import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import { findFlowByAlias, projectFromFields, projectFromLive, type KeycloakAuthFlowRep } from './_shared'

/**
 * Drift for authentication flows: compare the field we declare (description)
 * against the live flow container in Keycloak. alias is the identity (not
 * diffed); providerId is treated as immutable after creation and is not diffed
 * either, to avoid false drift against server-normalized values. Best-effort — a
 * flow that can't be matched (missing / transient error) is skipped rather than
 * raising false drift. A live match that is builtIn is also skipped — we never own
 * it (see the safety rule in _shared.ts / deploy.ts), so diffing it would just be
 * permanent, un-actionable noise. Read-only: GET /authentication/flows (list; no
 * direct get-by-alias endpoint).
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

    let match: KeycloakAuthFlowRep | null
    try {
      const res = await admin.get('/authentication/flows')
      if (!res.ok) continue // best-effort: can't read, don't assert drift
      const list = parseJson<KeycloakAuthFlowRep[]>(res.body) ?? []
      match = findFlowByAlias(list, alias)
    } catch {
      continue
    }
    if (!match) continue
    if (match.builtIn === true) continue // not ours to own — silence, not noise

    const expected = projectFromFields(item.fields)
    const actual = projectFromLive(match)

    // Only assert description drift when we actually declare a description.
    if (expected.description && expected.description !== actual.description) {
      diffs.push({
        field: `${alias}.description`,
        expected: expected.description,
        actual: actual.description,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
