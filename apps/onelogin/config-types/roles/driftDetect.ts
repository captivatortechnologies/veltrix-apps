import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient } from '../../lib/oneLogin'
import { getRoleApps, listRoles } from './deploy'
import { extractRoleSpecs } from './validate'

/**
 * Detect drift between the deployed role configuration and the live account.
 * Re-finds each declared role by NAME and diffs its assigned-apps SET
 * (order-insensitive - Set Role Apps has no documented ordering) against the
 * canvas's declared `appIds`.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRoleSpecs(ctx.deployedConfig).filter((s) => s.name)

  let roles
  try {
    roles = await listRoles(client)
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
    const live = roles.find((r) => r.name === spec.name) ?? null
    if (!live?.id) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveAppIds = await getRoleApps(client, live.id)
    const expectedSet = new Set(spec.appIds)
    const actualSet = new Set(liveAppIds)
    const sameSet = expectedSet.size === actualSet.size && [...expectedSet].every((id) => actualSet.has(id))

    if (!sameSet) {
      diffs.push({
        field: `${spec.name}.appIds`,
        expected: [...expectedSet].sort((a, b) => a - b).join(', ') || 'none',
        actual: [...actualSet].sort((a, b) => a - b).join(', ') || 'none',
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
