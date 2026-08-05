import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient } from '../../lib/teleport'
import { getDiscoveryConfig } from './deploy'
import { extractDiscoveryConfigSpecs, parseMatcherJson } from './validate'

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? [])
}

/**
 * Detect drift between the deployed discovery config and live Teleport state.
 * Compares discoveryGroup and each cloud's matcher array (order-sensitive
 * JSON comparison — Teleport does not guarantee matcher ordering is
 * preserved, so a reordered-but-otherwise-identical matcher list may read as
 * drift; this is a conservative choice over silently ignoring a real change).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDiscoveryConfigSpecs(ctx.deployedConfig).filter((s) => s.name && s.discoveryGroup)

  for (const spec of specs) {
    try {
      const live = await getDiscoveryConfig(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if (spec.discoveryGroup !== (live.discoveryGroup ?? '')) {
        diffs.push({
          field: `${spec.name}.discoveryGroup`,
          expected: spec.discoveryGroup,
          actual: live.discoveryGroup ?? '',
          severity: 'critical',
        })
      }

      const matcherFields: Array<[string, string, unknown[] | undefined]> = [
        ['awsMatchersJson', 'aws', live.aws],
        ['azureMatchersJson', 'azureMatchers', live.azureMatchers],
        ['gcpMatchersJson', 'gcpMatchers', live.gcpMatchers],
        ['kubeMatchersJson', 'kube', live.kube],
      ]
      for (const [specKey, label, liveValue] of matcherFields) {
        const parsed = parseMatcherJson((spec as unknown as Record<string, string>)[specKey])
        const expected = stableJson(parsed.ok ? parsed.value : [])
        const actual = stableJson(liveValue)
        if (expected !== actual) {
          diffs.push({ field: `${spec.name}.${label}`, expected, actual, severity: 'critical' })
        }
      }
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
