import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { loadPriorEntries } from './deploy'
import { extractSpecs, toOutboundMappingUpdateBody } from './_shared'

/**
 * Detect drift between the last-deployed outbound-NAT-mapping configuration
 * (`ctx.deployedConfig`) and live pfSense state. Tracked by canvas-item id
 * (see deploy.ts's module doc). A missing mapping or a match/target change
 * is CRITICAL; a behavior-only change (disabled/descr) is a WARNING.
 * Read-only.
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
    live = await client.listOutboundNatMappings()
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const liveById = new Map(live.filter((m) => m.id !== undefined).map((m) => [String(m.id), m]))

  for (const spec of specs) {
    const label = spec.descr || `outbound mapping (${spec.itemId})`
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

    const expected = toOutboundMappingUpdateBody(spec)
    if (found.interface !== expected.interface) diffs.push({ field: `${label}.interface`, expected: expected.interface, actual: found.interface, severity: 'critical' })
    if (found.source !== expected.source) diffs.push({ field: `${label}.source`, expected: expected.source, actual: found.source, severity: 'critical' })
    if (found.destination !== expected.destination) diffs.push({ field: `${label}.destination`, expected: expected.destination, actual: found.destination, severity: 'critical' })
    if ((found.target ?? undefined) !== expected.target) diffs.push({ field: `${label}.target`, expected: expected.target ?? '(none)', actual: found.target ?? '(none)', severity: 'critical' })
    if (Boolean(found.disabled) !== Boolean(expected.disabled)) {
      diffs.push({ field: `${label}.disabled`, expected: String(expected.disabled), actual: String(Boolean(found.disabled)), severity: 'warning' })
    }
    const liveDescr = (found.descr ?? '').trim()
    if (liveDescr !== spec.descr) diffs.push({ field: `${label}.descr`, expected: spec.descr, actual: liveDescr, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
