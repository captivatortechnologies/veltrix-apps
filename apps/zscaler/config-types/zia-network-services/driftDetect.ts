import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listNetworkServices } from './deploy'
import { extractNetworkServiceSpecs, type PortRange } from './validate'

/**
 * Detect drift between the deployed network service configuration and the live
 * tenant. Re-finds each declared service by name and diffs the managed scalar
 * fields (description + TCP/UDP destination ports); a missing service is
 * critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractNetworkServiceSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listNetworkServices(client)
    const byName = new Map(live.filter((s) => s.name).map((s) => [s.name as string, s]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveDescription = (typeof found.description === 'string' ? found.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      const expectedTcp = normalizePorts(spec.tcpPorts)
      const actualTcp = normalizePorts(found.destTcpPorts)
      if (expectedTcp !== actualTcp) {
        diffs.push({
          field: `${spec.name}.tcp_ports`,
          expected: expectedTcp || 'none',
          actual: actualTcp || 'none',
          severity: 'info',
        })
      }

      const expectedUdp = normalizePorts(spec.udpPorts)
      const actualUdp = normalizePorts(found.destUdpPorts)
      if (expectedUdp !== actualUdp) {
        diffs.push({
          field: `${spec.name}.udp_ports`,
          expected: expectedUdp || 'none',
          actual: actualUdp || 'none',
          severity: 'info',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'zia',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Canonical, order-independent string form of a port set for comparison. */
function normalizePorts(ports: PortRange[] | undefined): string {
  if (!Array.isArray(ports)) return ''
  return ports
    .map((p) => `${p.start}-${p.end}`)
    .sort()
    .join(',')
}
