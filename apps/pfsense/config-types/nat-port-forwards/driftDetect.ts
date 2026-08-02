import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { loadPriorEntries } from './deploy'
import { extractSpecs, toPortForwardUpdateBody } from './_shared'

/**
 * Detect drift between the last-deployed NAT port-forward configuration
 * (`ctx.deployedConfig`) and live pfSense state. Tracked by canvas-item id
 * (see deploy.ts's module doc) — a port forward this app never successfully
 * deployed cannot be drift-checked. A missing rule or a match/target change
 * is CRITICAL; a behavior-only change (descr/disabled/nordr/nosync) is a
 * WARNING. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const items = ctx.deployedConfig.items ?? ctx.deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const auth = await client.authenticate()
  if (auth.error) return { hasDrift: false, diffs }

  const specs = extractSpecs(items).filter((s) => s.itemId && s.interface)
  if (specs.length === 0) return { hasDrift: false, diffs }

  const prior = await loadPriorEntries(ctx.platform, ctx.deployedConfig)
  const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

  let live
  try {
    live = await client.listPortForwards()
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const liveById = new Map(live.filter((pf) => pf.id !== undefined).map((pf) => [String(pf.id), pf]))

  for (const spec of specs) {
    const label = spec.descr || `port forward (${spec.itemId})`
    const tracked = priorByItemId.get(spec.itemId)
    if (!tracked) {
      diffs.push({ field: label, expected: 'tracked', actual: 'never deployed', severity: 'warning' })
      continue
    }

    const found = liveById.get(String(tracked.id))
    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    const expected = toPortForwardUpdateBody(spec)
    if (found.interface !== expected.interface) diffs.push({ field: `${label}.interface`, expected: expected.interface, actual: found.interface, severity: 'critical' })
    if ((found.protocol ?? '') !== expected.protocol) diffs.push({ field: `${label}.protocol`, expected: expected.protocol, actual: found.protocol ?? '', severity: 'critical' })
    if (found.source !== expected.source) diffs.push({ field: `${label}.source`, expected: expected.source, actual: found.source, severity: 'critical' })
    if (found.destination !== expected.destination) diffs.push({ field: `${label}.destination`, expected: expected.destination, actual: found.destination, severity: 'critical' })
    if (found.target !== expected.target) diffs.push({ field: `${label}.target`, expected: expected.target, actual: found.target, severity: 'critical' })
    if (found.local_port !== expected.local_port) diffs.push({ field: `${label}.local_port`, expected: expected.local_port, actual: found.local_port, severity: 'critical' })
    if (Boolean(found.disabled) !== Boolean(expected.disabled)) {
      diffs.push({ field: `${label}.disabled`, expected: String(expected.disabled), actual: String(Boolean(found.disabled)), severity: 'warning' })
    }
    const liveDescr = (found.descr ?? '').trim()
    if (liveDescr !== spec.descr) diffs.push({ field: `${label}.descr`, expected: spec.descr, actual: liveDescr, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
