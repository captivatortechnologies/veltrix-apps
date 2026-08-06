import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOnePasswordClient } from '../../lib/onePassword'
import { listGroups } from './deploy'
import { listUsers } from '../users/deploy'
import { extractGroupSpecs } from './validate'

/**
 * Detect drift between the deployed group configuration and the live SCIM
 * Bridge. Re-finds each declared group by `displayName` and diffs its member
 * id SET (order-insensitive - SCIM Groups has no documented ordering)
 * against the canvas's declared members, re-resolved fresh from the current
 * live user list on every check.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOnePasswordClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractGroupSpecs(ctx.deployedConfig).filter((s) => s.displayName)

  let groups, users
  try {
    ;[groups, users] = await Promise.all([listGroups(client), listUsers(client)])
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'onepassword-scim-bridge',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  const emailById = new Map(users.filter((u) => u.id && u.userName).map((u) => [u.id!, u.userName!]))

  for (const spec of specs) {
    const live = groups.find((g) => (g.displayName ?? '').toLowerCase() === spec.displayName.toLowerCase()) ?? null
    if (!live) {
      diffs.push({ field: spec.displayName, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveEmails = new Set(
      (live.members ?? [])
        .map((m) => (m.value ? (emailById.get(m.value) ?? m.value) : null))
        .filter((v): v is string => Boolean(v))
        .map((v) => v.toLowerCase()),
    )
    const expectedEmails = new Set(spec.memberUserNames.map((v) => v.toLowerCase()))
    const sameSet = liveEmails.size === expectedEmails.size && [...expectedEmails].every((v) => liveEmails.has(v))

    if (!sameSet) {
      diffs.push({
        field: `${spec.displayName}.members`,
        expected: [...expectedEmails].sort().join(', ') || 'none',
        actual: [...liveEmails].sort().join(', ') || 'none',
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
