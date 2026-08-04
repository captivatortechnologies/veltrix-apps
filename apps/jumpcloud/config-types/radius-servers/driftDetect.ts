import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, JUMPCLOUD_API_BASE } from '../../lib/jumpcloudApi'
import { listRadiusServers } from './deploy'
import { extractRadiusServerSpecs, findRadiusServerByName } from './_shared'

const COMPARED_BOOL_FIELDS = ['userPasswordEnabled', 'userCertEnabled', 'deviceCertEnabled', 'requireTlsAuth', 'radsecEnabled', 'requireRadsec'] as const
const COMPARED_STRING_FIELDS = ['networkSourceIp', 'mfa', 'userLockoutAction', 'userPasswordExpirationAction', 'caSource', 'caCert'] as const

/**
 * Detect drift between the deployed RADIUS Server configuration and the live
 * org. Re-finds each declared server by name and diffs every managed field,
 * including the shared secret (JumpCloud's own GET response includes it, so
 * this is a legitimate comparison, not a leak of a value the API itself
 * withholds). Best-effort: if the org can't be read the check reports no drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings, { baseUrl: JUMPCLOUD_API_BASE })
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractRadiusServerSpecs(ctx.deployedConfig).filter((s) => s.name)

  let liveServers
  try {
    liveServers = await listRadiusServers(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort
  }

  for (const spec of specs) {
    const live = findRadiusServerByName(liveServers, spec.name)
    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (String(live.sharedSecret ?? '') !== spec.sharedSecret) {
      diffs.push({ field: `${spec.name}.sharedSecret`, expected: '(declared value)', actual: '(different)', severity: 'warning' })
    }

    for (const field of COMPARED_STRING_FIELDS) {
      const liveValue = String(live[field] ?? '')
      const desiredValue = spec[field]
      if (liveValue !== desiredValue) {
        diffs.push({ field: `${spec.name}.${field}`, expected: desiredValue, actual: liveValue, severity: 'info' })
      }
    }

    for (const field of COMPARED_BOOL_FIELDS) {
      const liveValue = Boolean(live[field])
      const desiredValue = spec[field]
      if (liveValue !== desiredValue) {
        diffs.push({ field: `${spec.name}.${field}`, expected: String(desiredValue), actual: String(liveValue), severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
