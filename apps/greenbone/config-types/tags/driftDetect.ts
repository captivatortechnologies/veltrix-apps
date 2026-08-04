import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort } from '../../lib/greenboneApi'
import { buildGetTagsCommand, parseTags } from '../../lib/gmp/tags'
import { buildTagInput, findTagByName } from './_shared'

/**
 * Drift for tags: compare the value, comment, active flag and resource type
 * we declare against the live tag in gvmd. Best-effort — a tag that can't be
 * matched is skipped. Read-only: <get_tags/>. GMP over TLS 9390.
 *
 * FLAG: the attached resource id LIST is not compared — get_tags' response
 * shape for it is not independently re-verified here (see
 * lib/gmp/tags.ts's FLAGS); every deploy unconditionally re-applies the
 * declared resourceIds via action="set" regardless.
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
      async (session) => parseTags(await session.send(buildGetTagsCommand())),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read tags, no drift asserted
  }

  for (const item of items) {
    const input = buildTagInput(item.fields)
    const match = findTagByName(live, input.name)
    if (!match) continue
    const label = input.name

    if (input.resourceType !== match.resourceType) diffs.push({ field: `${label}.resourceType`, expected: input.resourceType, actual: match.resourceType, severity: 'warning' })
    if ((input.value ?? '').trim() !== match.value.trim()) diffs.push({ field: `${label}.value`, expected: input.value ?? '', actual: match.value, severity: 'info' })
    if (Boolean(input.active) !== match.active) diffs.push({ field: `${label}.active`, expected: String(input.active), actual: String(match.active), severity: 'info' })

    const expectedComment = (input.comment ?? '').trim()
    if (expectedComment && expectedComment !== match.comment.trim()) {
      diffs.push({ field: `${label}.comment`, expected: expectedComment, actual: match.comment, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
