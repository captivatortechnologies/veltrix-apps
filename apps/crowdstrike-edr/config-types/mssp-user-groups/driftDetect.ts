import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findUserGroup, getUserGroupMembers, userGroupIdOf } from './deploy'
import { extractUserGroupSpecs } from './validate'

/**
 * Detect drift between the deployed MSSP user group configuration and the live
 * tenant state. Each declared group is looked up by its `name` identity and its
 * description + member UUID set are diffed. Attribution is best-effort — MSSP
 * entities may not carry a last-modifier field.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  const specs = extractUserGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findUserGroup(client, spec.name)
      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if ((live.description ?? '') !== (spec.description ?? '')) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: live.description ?? 'not set',
          severity: 'info',
        })
      }

      const id = userGroupIdOf(live)
      if (id) {
        const liveUuids = await getUserGroupMembers(client, id)
        if (!sameSet(liveUuids, spec.userUuids)) {
          diffs.push({
            field: `${spec.name}.userUuids`,
            expected: spec.userUuids.join(', ') || 'none',
            actual: liveUuids.join(', ') || 'none',
            severity: 'warning',
          })
        }
      }

      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
