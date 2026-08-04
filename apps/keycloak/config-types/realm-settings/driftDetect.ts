import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant } from '../../lib/keycloakApi'
import { BOOLEAN_FIELDS, NUMBER_FIELDS, fetchRealmRep, projectFromFields, projectFromRealmRep } from './_shared'

/**
 * Drift for realm-settings: compare the declared Tokens/Login/Password-Policy
 * fields against the live realm. Login flags always compare — the canvas gives
 * every one a real default, so they are never in an ambiguous "not declared"
 * state. Tokens numbers and the password policy compare only when declared: an
 * undeclared field is not managed by this config type (deploy leaves the
 * realm's live value untouched), so its live value is not asserted as drift
 * either. Read-only: GET /admin/realms/{realm}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  const diffs: DriftDiff[] = []

  if (!item || !resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  let live: Record<string, unknown> | null
  try {
    live = await fetchRealmRep(admin)
  } catch {
    return { hasDrift: false, diffs }
  }
  if (!live) return { hasDrift: false, diffs }

  const expected = projectFromFields(item.fields)
  const actual = projectFromRealmRep(live)

  for (const key of BOOLEAN_FIELDS) {
    if (expected[key] !== actual[key]) {
      diffs.push({ field: key, expected: expected[key], actual: actual[key], severity: 'warning' })
    }
  }

  for (const key of NUMBER_FIELDS) {
    if (expected[key] === undefined) continue
    if (expected[key] !== actual[key]) {
      diffs.push({ field: key, expected: expected[key], actual: actual[key] ?? 'not set', severity: 'warning' })
    }
  }

  if (expected.passwordPolicy !== undefined && expected.passwordPolicy !== (actual.passwordPolicy ?? '')) {
    diffs.push({
      field: 'passwordPolicy',
      expected: expected.passwordPolicy,
      actual: actual.passwordPolicy ?? '',
      severity: 'warning',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
