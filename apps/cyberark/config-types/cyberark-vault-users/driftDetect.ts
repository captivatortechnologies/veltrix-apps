import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { mapUsers } from './deploy'
import { extractVaultUserSpecs, usernameKey, type LiveVaultUser } from './validate'

/**
 * Detect drift between the deployed Vault-user configuration and the live
 * PVWA. Re-finds each declared user by username and diffs the managed
 * non-secret fields; a missing user is critical drift. The password is never
 * compared — CyberArk never returns it, and this app never diffs secrets.
 *
 * Vault users carry no last-modifier metadata over this API, so diffs are
 * reported without an actor.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractVaultUserSpecs(ctx.deployedConfig).filter((s) => s.username)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const byKey = await mapUsers(client)

    for (const spec of specs) {
      const found = byKey.get(usernameKey(spec))
      if (!found) {
        diffs.push({ field: spec.username, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      pushFieldDiffs(diffs, spec.username, spec, found)
    }
  } catch (error) {
    diffs.push({
      field: 'cyberark',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  await client.logoff()
  return { hasDrift: diffs.length > 0, diffs }
}

function pushFieldDiffs(diffs: DriftDiff[], username: string, spec: ReturnType<typeof extractVaultUserSpecs>[number], live: LiveVaultUser): void {
  if (spec.enableUser !== (live.enableUser ?? true)) {
    diffs.push({ field: `${username}.enable_user`, expected: spec.enableUser, actual: live.enableUser ?? true, severity: 'warning' })
  }
  if (spec.passwordNeverExpires !== (live.passwordNeverExpires ?? false)) {
    diffs.push({ field: `${username}.password_never_expires`, expected: spec.passwordNeverExpires, actual: live.passwordNeverExpires ?? false, severity: 'info' })
  }
  if (spec.location !== (live.location ?? '\\')) {
    diffs.push({ field: `${username}.location`, expected: spec.location, actual: live.location ?? 'not set', severity: 'info' })
  }
  if ((spec.description || undefined) !== (live.description || undefined)) {
    diffs.push({ field: `${username}.description`, expected: spec.description || '(empty)', actual: live.description || 'not set', severity: 'info' })
  }
}
