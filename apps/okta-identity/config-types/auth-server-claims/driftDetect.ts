import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findClaim } from './deploy'
import { buildClaimBody, extractClaimSpecs } from './validate'

/**
 * Detect drift between the deployed claim configuration and the live Okta org.
 * Each declared claim is re-found by name within its parent authorization server
 * and its authored fields are compared. Server-managed readOnly fields (id,
 * created, lastUpdated, system, _links, _embedded) are never modeled, so they
 * cannot read as drift. `status` is authored through the PUT body but is compared
 * separately (warning). A live `system: true` claim is Okta-managed and never
 * ours to converge, so it is skipped.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractClaimSpecs(ctx.deployedConfig).filter((s) => s.authServerId && s.name)

  for (const spec of specs) {
    const label = `${spec.authServerId}:${spec.name}`
    try {
      const live = await findClaim(client, spec.authServerId, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // A system:true claim is Okta-managed — deploy skips it, so it never drifts.
      if (live.system === true) continue

      // Compare every authored field except name (the match key) and status
      // (compared separately below). group_filter_type only appears for GROUPS.
      const desired = buildClaimBody(spec)
      for (const key of Object.keys(desired)) {
        if (key === 'name' || key === 'status') continue
        const expected = stableStringify(desired[key] ?? null)
        const actual = stableStringify((live as Record<string, unknown>)[key] ?? null)
        if (expected !== actual) {
          diffs.push({
            field: `${label}.${key}`,
            expected: desired[key] ?? 'not set',
            actual: (live as Record<string, unknown>)[key] ?? 'not set',
            severity: 'critical',
          })
        }
      }

      // status — authored via the PUT body; compared separately (warning).
      const liveStatus = (live.status ?? '').toString().toUpperCase()
      const desiredStatus = (spec.status ?? '').toUpperCase()
      if (desiredStatus && liveStatus && desiredStatus !== liveStatus) {
        diffs.push({
          field: `${label}.status`,
          expected: spec.status,
          actual: live.status ?? 'not set',
          severity: 'warning',
        })
      }
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
