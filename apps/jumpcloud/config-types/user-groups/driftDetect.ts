import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient } from '../../lib/jumpcloudApi'
import { listUserGroups } from './deploy'
import { extractUserGroupSpecs, findUserGroupByName, normalizeMembershipMethod } from './_shared'

/**
 * Detect drift between the deployed User Group configuration and the live org.
 * Re-finds each declared group by name and diffs the managed fields
 * (description, email, membershipMethod). A missing group is critical drift.
 *
 * Best-effort: if the org can't be read the check reports no drift rather than
 * raising a false positive. Only the fields this config type manages are compared
 * (server-managed fields like id and type are never diffed).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractUserGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  let liveGroups
  try {
    liveGroups = await listUserGroups(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read groups, no drift asserted
  }

  for (const spec of specs) {
    const live = findUserGroupByName(liveGroups, spec.name)
    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveDescription = String(live.description ?? '')
    if (spec.description !== liveDescription) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: spec.description || 'not set',
        actual: liveDescription || 'not set',
        severity: 'warning',
      })
    }

    if (spec.email) {
      const liveEmail = String(live.email ?? '')
      if (spec.email !== liveEmail) {
        diffs.push({ field: `${spec.name}.email`, expected: spec.email, actual: liveEmail || 'not set', severity: 'info' })
      }
    }

    const liveMethod = normalizeMembershipMethod(live.membershipMethod)
    if (spec.membershipMethod !== liveMethod) {
      diffs.push({ field: `${spec.name}.membershipMethod`, expected: spec.membershipMethod, actual: liveMethod, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
