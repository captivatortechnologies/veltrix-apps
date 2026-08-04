import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, normalizeBool } from '../../lib/secretServerApi'
import { extractConnectorSpecs, searchConnectors, findConnectorByName } from './_shared'

/**
 * Drift for connection managers: for each declared connector, re-find it by
 * name and compare the managed fields. A connector that can't be found is
 * critical drift. Best-effort — a read error asserts no drift rather than
 * raising a false critical. Read-only: GET
 * /api/v1/distributed-engine/site-connectors.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const items = ctx.deployedConfig.items ?? ctx.deployedConfig.sections ?? []
  const specs = extractConnectorSpecs(items).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  try {
    const allConnectors = await searchConnectors(client)
    for (const spec of specs) {
      const match = findConnectorByName(allConnectors, spec.name)
      if (!match) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const checks: Array<[string, unknown, unknown]> = [
        ['hostname', spec.hostname, match.hostName],
        ['active', spec.active, match.active !== undefined ? normalizeBool(match.active) : undefined],
        ['transportType', spec.transportType, match.queueType],
        ['useSsl', spec.useSsl, match.useSsl !== undefined ? normalizeBool(match.useSsl) : undefined],
      ]
      for (const [field, expected, actual] of checks) {
        if (actual !== undefined && expected !== actual) {
          diffs.push({ field: `${spec.name}.${field}`, expected, actual, severity: 'warning' })
        }
      }
    }
  } catch {
    return { hasDrift: false, diffs } // best-effort: unreadable → no drift asserted
  }

  return { hasDrift: diffs.length > 0, diffs }
}
