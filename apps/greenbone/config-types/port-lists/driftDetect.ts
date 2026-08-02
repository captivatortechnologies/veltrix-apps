import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, buildGetPortListsCommand, parsePortLists } from '../../lib/greenboneApi'
import { buildPortListInput, findPortListByName } from './_shared'

/**
 * Drift for port lists: compare the canonical port range and comment we declare
 * against the live port list in gvmd. The declared range and the live range are
 * both reduced to the same canonical "T:1-1024,U:53" form so ordering / spacing
 * never raise false drift. Best-effort — a list that can't be matched is skipped.
 * Read-only: <get_port_lists details="1"/>. GMP over TLS 9390.
 *
 * FLAG: a range diff here cannot be corrected by a re-deploy (modify_port_list
 * can't change ranges); it needs a recreate — the diff is severity "warning".
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
      async (session) => parsePortLists(await session.send(buildGetPortListsCommand())),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read port lists, no drift asserted
  }

  for (const item of items) {
    const input = buildPortListInput(item.fields)
    const match = findPortListByName(live, input.name)
    if (!match) continue
    const label = input.name

    if (input.portRange && input.portRange !== match.portRange) {
      diffs.push({ field: `${label}.portRange`, expected: input.portRange, actual: match.portRange, severity: 'warning' })
    }

    const expectedComment = (input.comment ?? '').trim()
    if (expectedComment && expectedComment !== match.comment.trim()) {
      diffs.push({ field: `${label}.comment`, expected: expectedComment, actual: match.comment, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
