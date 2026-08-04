import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import { DEPLOYMENTS_TUNNELS_PATH, listDeployment } from '../../lib/deployments'
import { extractTunnelSpecs, liveDeviceType, type LiveTunnel } from './_shared'

/**
 * Drift for tunnels: a declared tunnel absent from Umbrella is critical drift;
 * a present one is compared on device type only (a warning) — the PSK secret
 * is write-only and never returned, so it cannot be diffed. Best-effort and
 * read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractTunnelSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await listDeployment<LiveTunnel>(client, DEPLOYMENTS_TUNNELS_PATH)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByKey = new Map(
    listed.items.filter((l) => typeof l.name === 'string' && l.name).map((l) => [l.name!.toLowerCase(), l]),
  )

  const diffs: DriftResult['diffs'] = []
  for (const spec of specs) {
    const live = liveByKey.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const liveType = liveDeviceType(live)
    if (liveType && liveType.toLowerCase() !== spec.deviceType.toLowerCase()) {
      diffs.push({
        field: `${spec.name}.deviceType`,
        expected: spec.deviceType,
        actual: liveType,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
