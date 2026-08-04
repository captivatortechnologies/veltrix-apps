import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort } from '../../lib/greenboneApi'
import { buildGetNotesCommand, parseNotes } from '../../lib/gmp/notes'
import { extractSpecs, loadPriorEntries } from './_shared'

/**
 * Detect drift between the last-deployed note set and live gvmd state,
 * tracked by canvas-item id. Compares text/nvtOid/hosts/port — NOT the
 * "active" days-count (see lib/gmp/overrides.ts's FLAG, which applies
 * identically to notes: the read-side representation is not independently
 * verified to correspond to the write-side day count, so it is always
 * re-applied rather than diffed). Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential || !credential.username || !credential.password) return { hasDrift: false, diffs }

  const specs = extractSpecs(items).filter((s) => s.itemId && s.text && s.nvtOid)
  if (specs.length === 0) return { hasDrift: false, diffs }

  const prior = await loadPriorEntries(ctx.platform, canvas)
  const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

  let live
  try {
    live = await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component), timeoutMs: 8000 },
      { username: credential.username, password: credential.password },
      async (session) => parseNotes(await session.send(buildGetNotesCommand())),
    )
  } catch {
    return { hasDrift: false, diffs: [{ field: 'greenbone', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const liveById = new Map(live.map((n) => [n.id, n]))

  for (const spec of specs) {
    const label = `note (${spec.itemId})`
    const tracked = priorByItemId.get(spec.itemId)
    if (!tracked) {
      diffs.push({ field: label, expected: 'tracked', actual: 'never deployed', severity: 'warning' })
      continue
    }

    const found = liveById.get(tracked.noteId)
    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    if (found.text.trim() !== spec.text.trim()) diffs.push({ field: `${label}.text`, expected: spec.text, actual: found.text, severity: 'warning' })
    if (found.nvtOid !== spec.nvtOid) diffs.push({ field: `${label}.nvtOid`, expected: spec.nvtOid, actual: found.nvtOid, severity: 'critical' })
    if ((found.hosts ?? '').trim() !== (spec.hosts ?? '').trim()) diffs.push({ field: `${label}.hosts`, expected: spec.hosts ?? '', actual: found.hosts, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
