import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient } from '../../lib/jumpcloudApi'
import { listLdapServers } from './deploy'
import { extractLdapServerSettingsSpecs, findLdapServerByName } from './_shared'

/**
 * Detect drift between the deployed LDAP Server settings and the live org.
 * Re-finds each declared server by name and diffs only the MANAGED fields (an
 * action left unset is never compared, since this config type doesn't own it).
 * Best-effort: if the org can't be read the check reports no drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractLdapServerSettingsSpecs(ctx.deployedConfig).filter((s) => s.name)

  let liveServers
  try {
    liveServers = await listLdapServers(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort
  }

  for (const spec of specs) {
    const live = findLdapServerByName(liveServers, spec.name)
    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (spec.userLockoutAction) {
      const liveValue = String(live.user_lockout_action ?? '')
      if (liveValue !== spec.userLockoutAction) {
        diffs.push({ field: `${spec.name}.userLockoutAction`, expected: spec.userLockoutAction, actual: liveValue || '(unset)', severity: 'warning' })
      }
    }
    if (spec.userPasswordExpirationAction) {
      const liveValue = String(live.user_password_expiration_action ?? '')
      if (liveValue !== spec.userPasswordExpirationAction) {
        diffs.push({ field: `${spec.name}.userPasswordExpirationAction`, expected: spec.userPasswordExpirationAction, actual: liveValue || '(unset)', severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
