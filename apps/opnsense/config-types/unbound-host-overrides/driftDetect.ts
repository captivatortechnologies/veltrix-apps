import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { searchHostOverrides, type LiveHostOverride } from '../../lib/unboundApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { extractHostOverrideSpecs, hostOverrideKey } from './_shared'

/**
 * Detect drift between the deployed host-override configuration and the
 * live OPNsense box. Re-finds each declared override by (hostname, domain)
 * and diffs the managed fields: a missing override is critical drift; a
 * changed record type/address/enabled state is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractHostOverrideSpecs(ctx.deployedConfig).filter((s) => s.hostname && s.domain)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await searchHostOverrides(client)
    const byKey = new Map<string, LiveHostOverride>(
      live.filter((h) => h.hostname && h.domain).map((h) => [hostOverrideKey(h.hostname as string, h.domain as string), h]),
    )

    for (const spec of specs) {
      const label = `${spec.hostname}.${spec.domain}`
      const found = byKey.get(hostOverrideKey(spec.hostname, spec.domain))

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveEnabled = String(found.enabled ?? '1') === '1'
      if (liveEnabled !== spec.enabled) {
        diffs.push({ field: `${label}.enabled`, expected: spec.enabled ? 'enabled' : 'disabled', actual: liveEnabled ? 'enabled' : 'disabled', severity: 'warning' })
      }
      const liveRr = String(found.rr ?? 'A')
      if (liveRr !== spec.rr) {
        diffs.push({ field: `${label}.rr`, expected: spec.rr, actual: liveRr, severity: 'critical' })
      }
      const liveServer = String(found.server ?? '')
      if (liveServer !== spec.server) {
        diffs.push({ field: `${label}.server`, expected: spec.server || '(none)', actual: liveServer || '(none)', severity: 'warning' })
      }
    }
  } catch {
    diffs.push({ field: 'opnsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
