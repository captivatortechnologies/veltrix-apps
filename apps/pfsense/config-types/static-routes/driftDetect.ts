import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { loadPriorEntries } from './deploy'
import { extractSpecs } from './_shared'

/** Detect drift between the last-deployed static-route configuration and live pfSense state, tracked by canvas-item id. Read-only. */
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

  const specs = extractSpecs(items).filter((s) => s.itemId && s.network)
  if (specs.length === 0) return { hasDrift: false, diffs }

  const prior = await loadPriorEntries(ctx.platform, ctx.deployedConfig)
  const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

  let live
  try {
    live = await client.listStaticRoutes()
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const liveById = new Map(live.filter((r) => r.id !== undefined).map((r) => [String(r.id), r]))

  for (const spec of specs) {
    const label = spec.descr || `route (${spec.itemId})`
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

    if (found.network !== spec.network) diffs.push({ field: `${label}.network`, expected: spec.network, actual: found.network, severity: 'critical' })
    if (found.gateway !== spec.gateway) diffs.push({ field: `${label}.gateway`, expected: spec.gateway, actual: found.gateway, severity: 'critical' })
    if (Boolean(found.disabled) !== Boolean(spec.disabled)) {
      diffs.push({ field: `${label}.disabled`, expected: String(spec.disabled), actual: String(Boolean(found.disabled)), severity: 'warning' })
    }
    const liveDescr = (found.descr ?? '').trim()
    if (liveDescr !== spec.descr) diffs.push({ field: `${label}.descr`, expected: spec.descr, actual: liveDescr, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
