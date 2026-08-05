import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, stableStringify } from '../../lib/oneLogin'
import { getPrivilegeRoleIds, getPrivilegeUserIds, listPrivileges } from './deploy'
import { extractPrivilegeSpecs, parsePrivilegeDocument } from './validate'

/**
 * Detect drift between the deployed privilege configuration and the live
 * account. Re-finds each declared privilege by NAME and diffs description,
 * the statement document, and the assigned role/user id SETS
 * (order-insensitive).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPrivilegeSpecs(ctx.deployedConfig).filter((s) => s.name)

  let privileges
  try {
    privileges = await listPrivileges(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'onelogin-account',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  for (const spec of specs) {
    const live = privileges.find((p) => p.name === spec.name) ?? null
    if (!live?.id) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveDescription = typeof live.description === 'string' ? live.description : ''
    if ((spec.description ?? '') !== liveDescription) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: spec.description ?? 'not set',
        actual: liveDescription || 'not set',
        severity: 'info',
      })
    }

    const specDoc = parsePrivilegeDocument(spec.statementJson)
    if (specDoc && stableStringify(specDoc) !== stableStringify(live.privilege ?? {})) {
      diffs.push({
        field: `${spec.name}.statement`,
        expected: stableStringify(specDoc),
        actual: stableStringify(live.privilege ?? {}),
        severity: 'critical',
      })
    }

    const [liveRoleIds, liveUserIds] = await Promise.all([getPrivilegeRoleIds(client, live.id), getPrivilegeUserIds(client, live.id)])

    const expectedRoles = new Set(spec.roleIds)
    const actualRoles = new Set(liveRoleIds)
    if (expectedRoles.size !== actualRoles.size || [...expectedRoles].some((id) => !actualRoles.has(id))) {
      diffs.push({
        field: `${spec.name}.roleIds`,
        expected: [...expectedRoles].sort((a, b) => a - b).join(', ') || 'none',
        actual: [...actualRoles].sort((a, b) => a - b).join(', ') || 'none',
        severity: 'critical',
      })
    }

    const expectedUsers = new Set(spec.userIds)
    const actualUsers = new Set(liveUserIds)
    if (expectedUsers.size !== actualUsers.size || [...expectedUsers].some((id) => !actualUsers.has(id))) {
      diffs.push({
        field: `${spec.name}.userIds`,
        expected: [...expectedUsers].sort((a, b) => a - b).join(', ') || 'none',
        actual: [...actualUsers].sort((a, b) => a - b).join(', ') || 'none',
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
