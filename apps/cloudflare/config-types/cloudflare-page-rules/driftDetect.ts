import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { attachDriftActor, veltrixActorLogins } from '../lib/cloudflareAudit'
import { listPageRules } from './deploy'
import { extractPageRuleSpecs, livePageRulePattern, pageRuleKey, type LivePageRule } from './validate'

/**
 * Detect drift between the deployed Page Rules and the live zone. Re-finds each
 * declared rule by its URL pattern; a missing rule is critical drift and an
 * enabled/disabled (status) flip is informational drift. The actions body is not
 * deep-diffed and priority — which Cloudflare auto-normalises relative to the
 * zone's other rules — is intentionally not diffed; presence and status are the
 * managed signals (matching the redirect/transform rule types).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPageRuleSpecs(ctx.deployedConfig).filter((s) => s.urlPattern && s.actionsJson.trim())
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listPageRules(client)
    const byKey = new Map<string, LivePageRule>(
      live
        .map((r) => [pageRuleKey(livePageRulePattern(r)), r] as const)
        .filter(([key]) => key.length > 0),
    )

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.urlPattern
      const found = byKey.get(spec.key)
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: label, excludeActorLogins })
        continue
      }

      const liveEnabled = (found.status ?? 'active') === 'active'
      if (liveEnabled !== spec.enabled) {
        diffs.push({ field: `${label}.enabled`, expected: String(spec.enabled), actual: String(liveEnabled), severity: 'info' })
      }
      // Attribute every diff this rule produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), { targetId: found.id, targetName: label, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'cloudflare',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
