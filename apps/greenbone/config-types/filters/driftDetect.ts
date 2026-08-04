import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort } from '../../lib/greenboneApi'
import { buildGetFiltersCommand, parseFilters } from '../../lib/gmp/filters'
import { buildFilterInput, findFilterByName } from './_shared'

/**
 * Drift for filters: compare the type, term and comment we declare against
 * the live filter in gvmd. Best-effort — a filter that can't be matched is
 * skipped. Read-only: <get_filters/>. GMP over TLS 9390.
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
      async (session) => parseFilters(await session.send(buildGetFiltersCommand())),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read filters, no drift asserted
  }

  for (const item of items) {
    const input = buildFilterInput(item.fields)
    const match = findFilterByName(live, input.name)
    if (!match) continue
    const label = input.name

    if (input.type && input.type !== match.type) diffs.push({ field: `${label}.type`, expected: input.type, actual: match.type, severity: 'warning' })
    if ((input.term ?? '').trim() !== match.term.trim()) diffs.push({ field: `${label}.term`, expected: input.term ?? '', actual: match.term, severity: 'warning' })

    const expectedComment = (input.comment ?? '').trim()
    if (expectedComment && expectedComment !== match.comment.trim()) {
      diffs.push({ field: `${label}.comment`, expected: expectedComment, actual: match.comment, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
