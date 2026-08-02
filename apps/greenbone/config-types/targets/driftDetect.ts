import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, buildGetTargetsCommand, parseTargets } from '../../lib/greenboneApi'
import { buildTargetInput, findTargetByName, normalizeHosts } from './_shared'

/**
 * Drift for scan targets: compare the hosts, exclude-hosts, comment and port list
 * we declare against the live target in gvmd. Best-effort — a target that can't be
 * matched (missing / transient error) is skipped rather than raising false drift.
 * Read-only: <get_targets/>. Applied over GMP (XML over TLS, 9390).
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
      async (session) => parseTargets(await session.send(buildGetTargetsCommand())),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read targets, no drift asserted
  }

  for (const item of items) {
    const input = buildTargetInput(item.fields)
    const match = findTargetByName(live, input.name)
    if (!match) continue
    const label = input.name

    const expectedHosts = normalizeHosts(input.hosts)
    const actualHosts = normalizeHosts(match.hosts)
    if (expectedHosts !== actualHosts) {
      diffs.push({ field: `${label}.hosts`, expected: expectedHosts, actual: actualHosts, severity: 'warning' })
    }

    const expectedExclude = normalizeHosts(input.excludeHosts)
    const actualExclude = normalizeHosts(match.excludeHosts)
    if (expectedExclude !== actualExclude) {
      diffs.push({ field: `${label}.excludeHosts`, expected: expectedExclude, actual: actualExclude, severity: 'warning' })
    }

    if (match.portListId && input.portListId && match.portListId !== input.portListId) {
      diffs.push({ field: `${label}.portListId`, expected: input.portListId, actual: match.portListId, severity: 'warning' })
    }

    const expectedComment = (input.comment ?? '').trim()
    if (expectedComment && expectedComment !== match.comment.trim()) {
      diffs.push({ field: `${label}.comment`, expected: expectedComment, actual: match.comment, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
