import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import { canonicalJson, extractClientProfileSpecs, parseExecutorsField, type ClientProfileRepresentation, type ClientProfilesRepresentation } from './_shared'

/**
 * Detect drift for client profiles: ONE GET of the complete live custom-profile list
 * (`profiles`, never `globalProfiles`), then a per-item diff against the declared
 * canvas items by `name`. A declared profile missing from the live list is drift
 * itself (declared but not deployed) — critical, since a successful prior deploy
 * should have created it. `description` and `executors` differences are warnings;
 * `executors` is compared as an ordered list (order is significant — reordering
 * executors changes enforcement order), same as cisco-meraki's rule-array comparisons.
 * Best-effort: an unreadable target raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const diffs: DriftDiff[] = []

  if (!resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  const specs = extractClientProfileSpecs(deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live: ClientProfileRepresentation[]
  try {
    const res = await admin.get('/client-policies/profiles')
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, don't assert drift
    const parsed = parseJson<ClientProfilesRepresentation>(res.body)
    live = parsed?.profiles ?? []
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const spec of specs) {
    const { executors, error } = parseExecutorsField(spec.executorsRaw)
    if (error || !executors) continue // invalid executors JSON is a validate-time concern, not drift

    const match = live.find((p) => p.name === spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedDescription = spec.description ?? ''
    const actualDescription = match.description ?? ''
    if (expectedDescription !== actualDescription) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: expectedDescription,
        actual: actualDescription,
        severity: 'warning',
      })
    }

    const expectedExecutorsJson = canonicalJson(executors)
    const actualExecutorsJson = canonicalJson(match.executors ?? [])
    if (expectedExecutorsJson !== actualExecutorsJson) {
      diffs.push({
        field: `${spec.name}.executors`,
        expected: executors,
        actual: match.executors ?? [],
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
