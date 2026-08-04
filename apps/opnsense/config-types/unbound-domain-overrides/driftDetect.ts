import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { searchDomainOverrides, type LiveDomainOverride } from '../../lib/unboundApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { domainOverrideKey, extractDomainOverrideSpecs } from './_shared'

/**
 * Detect drift between the deployed domain-override configuration and the
 * live OPNsense box. Re-finds each declared override by domain (among
 * "forward"-type entries only) and diffs the managed fields: a missing
 * override is critical drift; a changed server/enabled state is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractDomainOverrideSpecs(ctx.deployedConfig).filter((s) => s.domain)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = (await searchDomainOverrides(client)).filter((d) => (d.type ?? 'forward') === 'forward')
    const byKey = new Map<string, LiveDomainOverride>(live.filter((d) => d.domain).map((d) => [domainOverrideKey(d.domain as string), d]))

    for (const spec of specs) {
      const found = byKey.get(domainOverrideKey(spec.domain))

      if (!found) {
        diffs.push({ field: spec.domain, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveEnabled = String(found.enabled ?? '1') === '1'
      if (liveEnabled !== spec.enabled) {
        diffs.push({
          field: `${spec.domain}.enabled`,
          expected: spec.enabled ? 'enabled' : 'disabled',
          actual: liveEnabled ? 'enabled' : 'disabled',
          severity: 'warning',
        })
      }
      const liveServer = String(found.server ?? '')
      if (liveServer !== spec.server) {
        diffs.push({ field: `${spec.domain}.server`, expected: spec.server, actual: liveServer || '(none)', severity: 'critical' })
      }
    }
  } catch {
    diffs.push({ field: 'opnsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
