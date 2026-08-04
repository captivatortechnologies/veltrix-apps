import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { getSessionPolicy } from './deploy'
import { extractSessionPolicySpecs, liveConnectorMap } from './validate'

/**
 * Detect drift between the deployed session policy and the live PVWA. A
 * platform whose GET fails (e.g. the platform was deleted) is critical
 * drift; otherwise the PSM server + declared connector states are diffed.
 *
 * This policy carries no creator/modifier metadata over this API, so diffs
 * are reported without an actor.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSessionPolicySpecs(ctx.deployedConfig).filter((s) => s.platformId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  for (const spec of specs) {
    try {
      const live = await getSessionPolicy(client, spec.platformId)
      if (spec.psmServerId && spec.psmServerId !== (live.PSMServerId ?? '')) {
        diffs.push({ field: `${spec.platformId}.psm_server_id`, expected: spec.psmServerId, actual: live.PSMServerId ?? 'not set', severity: 'critical' })
      }
      const liveConnectors = liveConnectorMap(live.PSMConnectors)
      for (const [connectorId, enabled] of Object.entries(spec.psmConnectors)) {
        const liveEnabled = liveConnectors[connectorId] ?? false
        if (liveEnabled !== enabled) {
          diffs.push({ field: `${spec.platformId}.psm_connectors.${connectorId}`, expected: enabled, actual: liveEnabled, severity: 'warning' })
        }
      }
    } catch (error) {
      diffs.push({
        field: spec.platformId,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  await client.logoff()
  return { hasDrift: diffs.length > 0, diffs }
}
