import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listProvisioningKeys } from './deploy'
import { DEFAULT_MAX_USAGE, extractProvisioningKeySpecs, type LiveProvisioningKey } from './validate'

/**
 * Detect drift between the deployed provisioning key configuration and the live
 * tenant. Re-finds each declared key by name within its association type and
 * diffs ONLY the managed scalar fields (maxUsage, enabled); a missing key is
 * critical drift.
 *
 * ⚠ The key SECRET (`provisioningKey`) is NEVER read — it is write-only, cannot
 * be re-fetched, and diffing it would leak it. maxUsage + enabled are the only
 * fields compared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  if (!client.hasCustomerId) return { hasDrift: false, diffs: [] }

  const specs = extractProvisioningKeySpecs(ctx.deployedConfig).filter((s) => s.name && s.associationType)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    // Re-list once per association type, then diff each declared key.
    const keysByType = new Map<string, Map<string, LiveProvisioningKey>>()

    for (const spec of specs) {
      let byName = keysByType.get(spec.associationType)
      if (!byName) {
        const items = await listProvisioningKeys(client, spec.associationType)
        byName = new Map(items.filter((k) => k.name).map((k) => [k.name as string, k]))
        keysByType.set(spec.associationType, byName)
      }

      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({
          field: `${spec.associationType}/${spec.name}`,
          expected: 'exists',
          actual: 'missing',
          severity: 'critical',
        })
        continue
      }

      // maxUsage only — ZPA returns it as a string, compare stringified.
      const expectedMaxUsage = String(spec.maxUsage ?? DEFAULT_MAX_USAGE)
      const liveMaxUsage = found.maxUsage != null ? String(found.maxUsage) : ''
      if (expectedMaxUsage !== liveMaxUsage) {
        diffs.push({
          field: `${spec.name}.maxUsage`,
          expected: expectedMaxUsage,
          actual: liveMaxUsage || 'not set',
          severity: 'warning',
        })
      }

      // enabled only.
      const liveEnabled = found.enabled ?? true
      if (spec.enabled !== liveEnabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: String(spec.enabled),
          actual: String(liveEnabled),
          severity: 'warning',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'zpa',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
