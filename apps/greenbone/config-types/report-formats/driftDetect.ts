import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort } from '../../lib/greenboneApi'
import { buildGetReportFormatsCommand, parseReportFormats } from '../../lib/gmp/reportFormats'
import { extractSpecs, loadPriorEntries } from './_shared'

/**
 * Detect drift between the last-deployed report-format tuning and live gvmd
 * state, tracked by canvas-item id (resolving to the declared reportFormatId
 * when present, else the tracked cloned id). Compares active/name/summary and
 * every declared param value. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential || !credential.username || !credential.password) return { hasDrift: false, diffs }

  const specs = extractSpecs(items).filter((s) => s.itemId && (s.reportFormatId || s.cloneFrom))
  if (specs.length === 0) return { hasDrift: false, diffs }

  const prior = await loadPriorEntries(ctx.platform, canvas)
  const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

  let live
  try {
    live = await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component), timeoutMs: 8000 },
      { username: credential.username, password: credential.password },
      async (session) => parseReportFormats(await session.send(buildGetReportFormatsCommand())),
    )
  } catch {
    return { hasDrift: false, diffs: [{ field: 'greenbone', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const liveById = new Map(live.map((r) => [r.id, r]))

  for (const spec of specs) {
    const tracked = priorByItemId.get(spec.itemId)
    const targetId = spec.reportFormatId || tracked?.reportFormatId || ''
    const label = `report format (${targetId || spec.itemId})`
    if (!targetId) {
      diffs.push({ field: label, expected: 'tracked', actual: 'never deployed', severity: 'warning' })
      continue
    }

    const found = liveById.get(targetId)
    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    if (found.active !== spec.active) diffs.push({ field: `${label}.active`, expected: String(spec.active), actual: String(found.active), severity: 'warning' })
    if (spec.name && spec.name !== found.name) diffs.push({ field: `${label}.name`, expected: spec.name, actual: found.name, severity: 'info' })

    for (const p of spec.params) {
      const liveValue = found.params[p.name]
      if (liveValue !== undefined && liveValue !== p.value) {
        diffs.push({ field: `${label}.params.${p.name}`, expected: p.value, actual: liveValue, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
