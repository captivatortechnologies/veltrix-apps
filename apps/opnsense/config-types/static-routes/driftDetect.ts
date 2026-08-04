import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { searchRoutes, type LiveRoute } from '../../lib/staticRoutesApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { extractRouteSpecs, routeKey } from './_shared'

/**
 * Detect drift between the deployed static-route configuration and the live
 * OPNsense box. Re-finds each declared route by network and diffs the
 * managed fields: a missing route is critical drift; a changed gateway or
 * enabled state is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractRouteSpecs(ctx.deployedConfig).filter((s) => s.network)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await searchRoutes(client)
    const byKey = new Map<string, LiveRoute>(live.filter((r) => r.network).map((r) => [routeKey(r.network as string), r]))

    for (const spec of specs) {
      const found = byKey.get(routeKey(spec.network))

      if (!found) {
        diffs.push({ field: spec.network, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveEnabled = String(found.enabled ?? '1') === '1'
      if (liveEnabled !== spec.enabled) {
        diffs.push({
          field: `${spec.network}.enabled`,
          expected: spec.enabled ? 'enabled' : 'disabled',
          actual: liveEnabled ? 'enabled' : 'disabled',
          severity: 'warning',
        })
      }
      const liveGateway = String(found.gateway ?? '')
      if (liveGateway !== spec.gateway) {
        diffs.push({ field: `${spec.network}.gateway`, expected: spec.gateway, actual: liveGateway || '(none)', severity: 'critical' })
      }
    }
  } catch {
    diffs.push({ field: 'opnsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
