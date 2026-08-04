import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import { stringSetsEqual } from '../../lib/fields'
import {
  canonicalJson,
  extractClientPolicySpecs,
  liveEnabled,
  parseConditionsField,
  type ClientPoliciesRepresentation,
  type ClientPolicyRepresentation,
} from './_shared'

/**
 * Detect drift for client policies: ONE GET of the complete live custom-policy list
 * (`policies`, never `globalPolicies`), then a per-item diff against the declared
 * canvas items by `name`. A declared policy missing from the live list is drift
 * itself (declared but not deployed) — critical, since a successful prior deploy
 * should have created it. `enabled`, `conditions` (ordered — order is significant,
 * same rationale as the executor-array comparison in client-profiles) and `profiles`
 * (compared as a SET — profile application order does not matter) differences are
 * warnings. Best-effort: an unreadable target raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const diffs: DriftDiff[] = []

  if (!resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  const specs = extractClientPolicySpecs(deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live: ClientPolicyRepresentation[]
  try {
    const res = await admin.get('/client-policies/policies')
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, don't assert drift
    const parsed = parseJson<ClientPoliciesRepresentation>(res.body)
    live = parsed?.policies ?? []
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const spec of specs) {
    const { conditions, error } = parseConditionsField(spec.conditionsRaw)
    if (error || !conditions) continue // invalid conditions JSON is a validate-time concern, not drift

    const match = live.find((p) => p.name === spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const actualEnabled = liveEnabled(match)
    if (spec.enabled !== actualEnabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: spec.enabled, actual: actualEnabled, severity: 'warning' })
    }

    const expectedConditionsJson = canonicalJson(conditions)
    const actualConditionsJson = canonicalJson(match.conditions ?? [])
    if (expectedConditionsJson !== actualConditionsJson) {
      diffs.push({
        field: `${spec.name}.conditions`,
        expected: conditions,
        actual: match.conditions ?? [],
        severity: 'warning',
      })
    }

    const actualProfiles = match.profiles ?? []
    if (!stringSetsEqual(spec.profiles, actualProfiles)) {
      diffs.push({
        field: `${spec.name}.profiles`,
        expected: spec.profiles,
        actual: actualProfiles,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
