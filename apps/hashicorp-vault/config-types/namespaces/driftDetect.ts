import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { getNamespace } from './deploy'
import { extractNamespaceSpecs, resolveMetadata } from './validate'

/**
 * Detect drift between the deployed namespace configuration and the live
 * cluster. Re-reads each namespace from GET /sys/namespaces/{path} and diffs
 * custom_metadata (compared key-by-key so an added/removed/changed key is
 * called out individually).
 *
 * A missing namespace is `critical`. A metadata mismatch is `warning` — it
 * converges on the next deploy.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractNamespaceSpecs(ctx.deployedConfig).filter((s) => s.path)

  for (const spec of specs) {
    try {
      const live = await getNamespace(client, spec.path)

      if (!live) {
        diffs.push({ field: spec.path, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }

      const expected = resolveMetadata(spec.customMetadataJson)
      const actual = live.custom_metadata ?? {}
      const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
      for (const key of keys) {
        if ((expected[key] ?? '') !== (actual[key] ?? '')) {
          diffs.push({
            field: `${spec.path}.customMetadata.${key}`,
            expected: expected[key] ?? 'not set',
            actual: actual[key] ?? 'not set',
            severity: 'warning',
          })
        }
      }
    } catch (error) {
      diffs.push({
        field: spec.path,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
