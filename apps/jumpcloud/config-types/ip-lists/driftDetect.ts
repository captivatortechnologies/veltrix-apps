import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient } from '../../lib/jumpcloudApi'
import { listIpLists } from './deploy'
import { extractIpListSpecs, findIpListByName } from './_shared'

/**
 * Detect drift between the deployed IP List configuration and the live org.
 * Re-finds each declared list by name and diffs description + the full ips set
 * (order-insensitive). Best-effort: if the org can't be read the check reports no
 * drift rather than raising a false positive.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractIpListSpecs(ctx.deployedConfig).filter((s) => s.name)

  let liveLists
  try {
    liveLists = await listIpLists(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort
  }

  for (const spec of specs) {
    const live = findIpListByName(liveLists, spec.name)
    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveDescription = String(live.description ?? '')
    if (liveDescription !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: liveDescription, severity: 'info' })
    }

    const liveIps = new Set((live.ips ?? []).map((ip) => ip.trim().toLowerCase()))
    const desiredIps = new Set(spec.ips.map((ip) => ip.trim().toLowerCase()))
    const sameSize = liveIps.size === desiredIps.size
    const sameMembers = sameSize && [...desiredIps].every((ip) => liveIps.has(ip))
    if (!sameMembers) {
      diffs.push({
        field: `${spec.name}.ips`,
        expected: [...desiredIps].sort().join(', ') || '(none)',
        actual: [...liveIps].sort().join(', ') || '(none)',
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
