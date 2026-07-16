import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { getPolicyWithSettings, listConfigurationPolicies, parsePolicyJson, stableSettingsHash } from '../../lib/policy'
import { extractPolicySpecs, policyKey } from './validate'

/**
 * Detect drift between the deployed imported policies and the live tenant. A
 * declared policy that no longer exists is critical drift. Because the settings
 * tree is opaque, drift on the settings is reported coarsely: the live settings
 * are compared to the declared settings by an order-insensitive hash.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const liveList = await listConfigurationPolicies(client)
    const byName = new Map(liveList.filter((p) => p.name && p.id).map((p) => [policyKey(p.name as string), p]))

    for (const spec of specs) {
      const livePolicy = byName.get(policyKey(spec.name))
      if (!livePolicy || !livePolicy.id) {
        diffs.push({ field: `policy:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const parsed = parsePolicyJson(spec.policyJsonRaw)
      if (!parsed.value) continue
      const full = await getPolicyWithSettings(client, livePolicy.id)
      if (!full) continue
      const want = stableSettingsHash(parsed.value.settings ?? [])
      const have = stableSettingsHash(full.settings ?? [])
      if (want !== have) {
        diffs.push({ field: `${spec.name}.settings`, expected: 'as declared', actual: 'differs from declared', severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({ field: 'intune', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
