import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { attachDriftActor, veltrixActorLogins } from '../lib/wizAuditLog'
import { listServiceAccounts } from './deploy'
import { accountKey, extractServiceAccountSpecs, sameStringSet, type LiveServiceAccount } from './validate'

/**
 * Detect drift between the deployed service-account configuration and the live
 * tenant. Re-finds each declared account by name and diffs the managed fields:
 * a missing account is critical drift; a changed scope set or type is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractServiceAccountSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listServiceAccounts(client)
    const byName = new Map<string, LiveServiceAccount>(
      live.filter((a) => a.name).map((a) => [accountKey(a.name as string), a]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.name
      const found = byName.get(accountKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute the deletion by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      if (found.type && found.type !== spec.type) {
        diffs.push({ field: `${label}.type`, expected: spec.type, actual: found.type, severity: 'warning' })
      }
      const liveScopes = Array.isArray(found.scopes) ? found.scopes : []
      if (!sameStringSet(liveScopes, spec.scopes)) {
        diffs.push({
          field: `${label}.scopes`,
          expected: spec.scopes.join(', ') || '(none)',
          actual: liveScopes.join(', ') || '(none)',
          severity: 'warning',
        })
      }

      // Attribute every diff this account produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.id,
        targetName: spec.name,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'wiz',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
