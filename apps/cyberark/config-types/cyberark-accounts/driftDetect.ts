import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { attachDriftActor, veltrixActorLogins } from '../lib/cyberarkAudit'
import { findAccount } from './deploy'
import { extractAccountSpecs } from './validate'

/**
 * Detect drift between the deployed account configuration and the live PVWA.
 * Re-finds each declared account by (name, safe) and diffs the managed non-secret
 * fields (address, userName, automatic management); a missing account is critical
 * drift.
 *
 * ⚠ SECRET: the account secret is write-only and masked on read, so it is NEVER
 * read back or compared — doing so would either leak it or report perpetual drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAccountSpecs(ctx.deployedConfig).filter((s) => s.name && s.safeName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    for (const spec of specs) {
      const before = diffs.length
      const tag = `${spec.name}@${spec.safeName}`
      const found = await findAccount(client, spec)
      if (!found) {
        diffs.push({ field: tag, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if (spec.address && spec.address !== (found.address ?? '')) {
        diffs.push({ field: `${tag}.address`, expected: spec.address, actual: found.address ?? 'not set', severity: 'warning' })
      }
      if (spec.userName && spec.userName !== (found.userName ?? '')) {
        diffs.push({ field: `${tag}.userName`, expected: spec.userName, actual: found.userName ?? 'not set', severity: 'warning' })
      }
      const liveAuto = found.secretManagement?.automaticManagementEnabled ?? true
      if (liveAuto !== spec.automaticManagementEnabled) {
        diffs.push({ field: `${tag}.automaticManagement`, expected: spec.automaticManagementEnabled, actual: liveAuto, severity: 'info' })
      }

      // Attribute every diff this account produced to the last human change in
      // its Activities log (once) — no-op when nothing drifted or the change
      // was ours. A missing (deleted) account has no id, so it is left "—".
      if (found.id) {
        await attachDriftActor(client, diffs.slice(before), { accountId: found.id, excludeActorLogins })
      }
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
