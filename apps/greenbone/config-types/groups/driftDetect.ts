import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort } from '../../lib/greenboneApi'
import { buildGetGroupsCommand, parseGroups } from '../../lib/gmp/groups'
import { buildGroupInput, findGroupByName } from './_shared'

/**
 * Drift for groups: compare the comment, members and "full access" flag we
 * declare against the live group in gvmd. Best-effort — a group that can't be
 * matched is skipped. Read-only: <get_groups/>. GMP over TLS 9390.
 *
 * FLAG: a "full access" drift is severity "warning" — it CANNOT be corrected
 * by a re-deploy (modify_group has no specials field); it needs a delete +
 * recreate (same class of limitation as port-lists' immutable ranges).
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
      async (session) => parseGroups(await session.send(buildGetGroupsCommand())),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read groups, no drift asserted
  }

  for (const item of items) {
    const input = buildGroupInput(item.fields)
    const match = findGroupByName(live, input.name)
    if (!match) continue
    const label = input.name

    const expectedUsers = [...(input.users ?? [])].sort().join(',')
    const actualUsers = [...match.users].sort().join(',')
    if (expectedUsers !== actualUsers) diffs.push({ field: `${label}.users`, expected: expectedUsers, actual: actualUsers, severity: 'warning' })

    if (Boolean(input.specialsFull) !== match.specialsFull) {
      diffs.push({ field: `${label}.specialsFull`, expected: String(Boolean(input.specialsFull)), actual: String(match.specialsFull), severity: 'warning' })
    }

    const expectedComment = (input.comment ?? '').trim()
    if (expectedComment && expectedComment !== match.comment.trim()) {
      diffs.push({ field: `${label}.comment`, expected: expectedComment, actual: match.comment, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
