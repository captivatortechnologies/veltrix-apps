import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { extractSpecs, gatewayKey } from './_shared'

/** Detect drift between the last-deployed gateway configuration and live pfSense state, matched by name. Read-only. */
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

  const specs = extractSpecs(items).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await client.listRoutingGateways()
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const byName = new Map(live.filter((g) => g.name).map((g) => [gatewayKey(g.name), g]))

  for (const spec of specs) {
    const found = byName.get(gatewayKey(spec.name))
    const label = spec.name

    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    if (found.interface !== spec.interface) diffs.push({ field: `${label}.interface`, expected: spec.interface, actual: found.interface, severity: 'critical' })
    if (found.gateway !== spec.gateway) diffs.push({ field: `${label}.gateway`, expected: spec.gateway, actual: found.gateway, severity: 'critical' })
    if (Boolean(found.disabled) !== spec.disabled) {
      diffs.push({ field: `${label}.disabled`, expected: String(spec.disabled), actual: String(Boolean(found.disabled)), severity: 'warning' })
    }
    const liveDescr = (found.descr ?? '').trim()
    if (liveDescr !== spec.descr) diffs.push({ field: `${label}.descr`, expected: spec.descr, actual: liveDescr, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
