import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort } from '../../lib/greenboneApi'
import { buildGetRolesCommand, parseRoles } from '../../lib/gmp/roles'
import { buildRoleInput, findRoleByName } from './_shared'

/**
 * Drift for roles: compare the comment and members we declare against the
 * live (non-predefined) role in gvmd. Best-effort — a role that can't be
 * matched is skipped. Read-only: <get_roles/>. GMP over TLS 9390.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential || !credential.username || !credential.password) return { hasDrift: false, diffs }

  let live
  try {
    live = await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component), timeoutMs: 8000 },
      { username: credential.username, password: credential.password },
      async (session) => parseRoles(await session.send(buildGetRolesCommand())),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read roles, no drift asserted
  }

  for (const item of items) {
    const input = buildRoleInput(item.fields)
    const match = findRoleByName(live, input.name)
    if (!match) continue
    const label = input.name

    const expectedUsers = [...(input.users ?? [])].sort().join(',')
    const actualUsers = [...match.users].sort().join(',')
    if (expectedUsers !== actualUsers) diffs.push({ field: `${label}.users`, expected: expectedUsers, actual: actualUsers, severity: 'warning' })

    const expectedComment = (input.comment ?? '').trim()
    if (expectedComment && expectedComment !== match.comment.trim()) {
      diffs.push({ field: `${label}.comment`, expected: expectedComment, actual: match.comment, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
