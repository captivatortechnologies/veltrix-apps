import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { extractSpecs, vipKey } from './_shared'

/**
 * Detect drift between the last-deployed virtual-IP configuration
 * (`ctx.deployedConfig`) and live pfSense state, matched by `subnet`
 * (identity). A missing VIP or a mode/interface/subnet_bits change is
 * CRITICAL; a description or CARP-tuning (advbase/advskew) change is a
 * WARNING. `password` is never compared (write-only in spirit — the REST
 * API package does not reliably echo CARP secrets back for comparison).
 * Read-only — never calls the apply endpoint.
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

  const specs = extractSpecs(items).filter((s) => s.mode && s.subnet)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await client.listVirtualIps()
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const bySubnet = new Map(live.filter((v) => v.subnet).map((v) => [vipKey(v.subnet), v]))

  for (const spec of specs) {
    const found = bySubnet.get(vipKey(spec.subnet))
    const label = spec.subnet

    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    if (found.mode !== spec.mode) diffs.push({ field: `${label}.mode`, expected: spec.mode, actual: found.mode, severity: 'critical' })
    if (found.interface !== spec.interface) diffs.push({ field: `${label}.interface`, expected: spec.interface, actual: found.interface, severity: 'critical' })
    if (found.subnet_bits !== spec.subnetBits) {
      diffs.push({ field: `${label}.subnet_bits`, expected: String(spec.subnetBits), actual: String(found.subnet_bits), severity: 'critical' })
    }
    const liveDescr = (found.descr ?? '').trim()
    if (liveDescr !== spec.descr) diffs.push({ field: `${label}.descr`, expected: spec.descr, actual: liveDescr, severity: 'warning' })

    if (spec.mode === 'carp') {
      if ((found.vhid ?? null) !== spec.vhid) diffs.push({ field: `${label}.vhid`, expected: String(spec.vhid), actual: String(found.vhid ?? ''), severity: 'critical' })
      if ((found.advbase ?? 1) !== spec.advbase) diffs.push({ field: `${label}.advbase`, expected: String(spec.advbase), actual: String(found.advbase ?? ''), severity: 'warning' })
      if ((found.advskew ?? 0) !== spec.advskew) diffs.push({ field: `${label}.advskew`, expected: String(spec.advskew), actual: String(found.advskew ?? ''), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
