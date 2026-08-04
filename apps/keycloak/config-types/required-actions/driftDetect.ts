import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import { readString, stringMapsEqual } from '../../lib/fields'
import { projectFromFields, projectFromLive, type KeycloakRequiredActionRep } from './_shared'

/**
 * Drift for required actions: compare enabled, defaultAction, priority and config
 * against the live provider in Keycloak. name drift is only asserted when a
 * non-blank name is declared AND differs (same "assert only when declared"
 * convention used elsewhere in this app) — providerId/alias are the identity and
 * are never diffed. Best-effort — an action that can't be read (not yet
 * registered / transient error) is skipped rather than raising false drift.
 * Read-only: GET /authentication/required-actions/{alias}.
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

    let match: KeycloakRequiredActionRep | null
    try {
      const res = await admin.get(`/authentication/required-actions/${encodeURIComponent(alias)}`)
      if (!res.ok) continue // best-effort: can't read (incl. not-yet-registered), don't assert drift
      match = parseJson<KeycloakRequiredActionRep>(res.body)
    } catch {
      continue
    }
    if (!match) continue

    const expected = projectFromFields(item.fields)
    const actual = projectFromLive(match)

    const declaredName = readString(item.fields.name)
    const liveName = readString(match.name)
    if (declaredName && declaredName !== liveName) {
      diffs.push({ field: `${alias}.name`, expected: declaredName, actual: liveName, severity: 'warning' })
    }
    if (expected.enabled !== actual.enabled) {
      diffs.push({ field: `${alias}.enabled`, expected: expected.enabled, actual: actual.enabled, severity: 'warning' })
    }
    if (expected.defaultAction !== actual.defaultAction) {
      diffs.push({
        field: `${alias}.defaultAction`,
        expected: expected.defaultAction,
        actual: actual.defaultAction,
        severity: 'warning',
      })
    }
    if (expected.priority !== undefined && expected.priority !== actual.priority) {
      diffs.push({
        field: `${alias}.priority`,
        expected: expected.priority,
        actual: actual.priority,
        severity: 'warning',
      })
    }
    if (!stringMapsEqual(expected.config, actual.config)) {
      diffs.push({ field: `${alias}.config`, expected: expected.config, actual: actual.config, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
