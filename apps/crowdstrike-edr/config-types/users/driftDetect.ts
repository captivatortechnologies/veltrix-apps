import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findUserByEmail, getUserRoleIds } from './deploy'
import { extractUserSpecs, type LiveUser, type UserSpec } from './validate'

/**
 * Detect drift between the deployed user configuration and the live tenant
 * state. For each declared user, diffs existence, name (when the canvas
 * declares one), and — when roles are managed — the direct role grant set.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractUserSpecs(ctx.deployedConfig).filter((s) => s.email)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findUserByEmail(client, spec.email)

      if (!live?.uuid) {
        diffs.push({ field: spec.email, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffName(spec, live))

      if (spec.manageRoles) {
        const liveRoles = await getUserRoleIds(client, live.uuid)
        if (!sameSet(liveRoles, spec.roleIds)) {
          // Roles the user holds but the canvas never declared are unexpected
          // privilege — more serious than a missing declared role.
          const extraRoles = liveRoles.some((r) => !spec.roleIds.includes(r))
          diffs.push({
            field: `${spec.email}.roleIds`,
            expected: spec.roleIds.join(', ') || 'none',
            actual: liveRoles.join(', ') || 'none',
            severity: extraRoles ? 'critical' : 'warning',
          })
        }
      }

      // Best-effort attribution — Falcon user resources do not reliably carry a
      // modifier field, so this is usually a no-op (the UI shows "—").
      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: spec.email,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function diffName(spec: UserSpec, live: LiveUser): DriftDiff[] {
  const diffs: DriftDiff[] = []

  if (spec.firstName !== undefined && spec.firstName !== (live.first_name ?? '')) {
    diffs.push({
      field: `${spec.email}.firstName`,
      expected: spec.firstName,
      actual: live.first_name || 'not set',
      severity: 'info',
    })
  }
  if (spec.lastName !== undefined && spec.lastName !== (live.last_name ?? '')) {
    diffs.push({
      field: `${spec.email}.lastName`,
      expected: spec.lastName,
      actual: live.last_name || 'not set',
      severity: 'info',
    })
  }

  return diffs
}
