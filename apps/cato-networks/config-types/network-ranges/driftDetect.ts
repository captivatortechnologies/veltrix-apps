import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCatoClient, responseError } from '../../lib/cato'
import { findGlobalIpRange, globalIpRangesFromList, LIST_GLOBAL_IP_RANGES } from './_shared'
import { extractNetworkRangeSpecs } from './validate'

/** Drift: re-find each declared Network Range by name and diff description/ipRange. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client, accountId } = built

  const specs = extractNetworkRangeSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const listRes = await client.graphql(LIST_GLOBAL_IP_RANGES, { accountId })
  const err = responseError(listRes)
  if (err) {
    return { hasDrift: true, diffs: [{ field: 'cato', expected: 'reachable', actual: `list failed: ${err}`, severity: 'critical' }] }
  }
  const live = globalIpRangesFromList(listRes.data)

  for (const spec of specs) {
    const found = findGlobalIpRange(live, spec.name)
    if (!found) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }
    if (spec.ipRange && found.ipRange && spec.ipRange !== found.ipRange) {
      diffs.push({ field: `${spec.name}.ipRange`, expected: spec.ipRange, actual: found.ipRange, severity: 'warning' })
    }
    const expectedDesc = (spec.description ?? '').trim()
    const actualDesc = (found.description ?? '').trim()
    if (expectedDesc !== actualDesc) {
      diffs.push({ field: `${spec.name}.description`, expected: expectedDesc, actual: actualDesc, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
