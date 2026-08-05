import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { listPolicies } from './deploy'
import { extractPolicySpecs, policyKey, type LivePolicy } from './validate'

/** Snyk audit event-name prefixes for org-level policy changes (best-effort attribution). */
const POLICY_EVENT_PREFIXES = ['org.policy', 'org.policies']

/**
 * Detect drift between the deployed org-level ignore policies and the live
 * org. A declared policy that no longer exists is critical drift; a changed
 * finding-match value, ignore type or expiry is a warning. The read-only
 * `review` status is never diffed (out of scope — an approval workflow, not
 * declarative config).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listPolicies(client)
    const excludeActorLogins = veltrixActorLogins(ctx.credential)
    const byName = new Map<string, LivePolicy>(
      live.filter((p) => p.attributes?.name).map((p) => [policyKey(p.attributes!.name as string), p]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const found = byName.get(policyKey(spec.name))

      if (!found) {
        diffs.push({ field: `policy:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
      } else {
        const liveValue = found.attributes?.conditions_group?.conditions?.[0]?.value
        if (spec.findingKey && liveValue !== undefined && liveValue !== spec.findingKey) {
          diffs.push({ field: `policy:${spec.name}.finding_key`, expected: spec.findingKey, actual: liveValue, severity: 'warning' })
        }
        const liveIgnoreType = found.attributes?.action?.data?.ignore_type
        if (liveIgnoreType !== undefined && liveIgnoreType !== spec.ignoreType) {
          diffs.push({ field: `policy:${spec.name}.ignore_type`, expected: spec.ignoreType, actual: liveIgnoreType, severity: 'warning' })
        }
        const liveExpires = found.attributes?.action?.data?.expires ?? ''
        if (spec.expires && liveExpires !== spec.expires) {
          diffs.push({ field: `policy:${spec.name}.expires`, expected: spec.expires, actual: liveExpires || '(none)', severity: 'warning' })
        }
      }

      await attachDriftActor(client, diffs.slice(before), {
        targetId: found?.id,
        targetName: spec.name,
        eventPrefixes: POLICY_EVENT_PREFIXES,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'snyk',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
