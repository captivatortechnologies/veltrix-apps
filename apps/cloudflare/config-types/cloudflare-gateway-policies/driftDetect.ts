import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { attachDriftActor, veltrixActorLogins } from '../lib/cloudflareAudit'
import { listGatewayPolicies } from './deploy'
import { extractGatewayPolicySpecs, type LiveGatewayPolicy } from './validate'

/**
 * Detect drift between the deployed Gateway configuration and the live account.
 * Re-finds each declared policy by name and diffs the managed fields (action,
 * enabled); a missing policy is critical drift. Returns no drift when no account
 * id is available (account-scoped objects can't be read without one).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  if (!(await client.hasAccount())) return { hasDrift: false, diffs: [] }

  const specs = extractGatewayPolicySpecs(ctx.deployedConfig).filter((s) => s.name && s.action && s.traffic)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listGatewayPolicies(client)
    const byName = new Map<string, LiveGatewayPolicy>(live.filter((p) => p.name).map((p) => [p.name as string, p]))

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.name
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      if ((found.action ?? '') !== spec.action) {
        diffs.push({ field: `${label}.action`, expected: spec.action, actual: found.action ?? 'unknown', severity: 'warning' })
      }
      if ((found.enabled ?? true) !== spec.enabled) {
        diffs.push({
          field: `${label}.enabled`,
          expected: String(spec.enabled),
          actual: String(found.enabled ?? true),
          severity: 'warning',
        })
      }
      // Attribute every diff this policy produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), { targetId: found.id, targetName: spec.name, excludeActorLogins })
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
