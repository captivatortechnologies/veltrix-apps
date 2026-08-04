import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus, parseCreatedId, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildGetReportFormatsCommand, buildCreateReportFormatCommand, buildModifyReportFormatCommand, buildDeleteReportFormatCommand, parseReportFormats } from '../../lib/gmp/reportFormats'
import { extractSpecs, loadPriorEntries, type RollbackEntry } from './_shared'

async function listReportFormats(session: GmpSession) {
  return parseReportFormats(await session.send(buildGetReportFormatsCommand()))
}

/**
 * Deploy Greenbone report formats over GMP (XML over TLS, 9390):
 *   read:   <get_report_formats filter="rows=-1"/>  → resolve the target id
 *           (declared reportFormatId, or a previously-cloned id tracked by
 *           canvas item), and snapshot its CURRENT fields for rollback BEFORE
 *           tuning it
 *   create: <create_report_format><copy>…</copy></create_report_format> →
 *           ONLY when reportFormatId is blank and no live tracked clone
 *           exists (clone-only — see lib/gmp/reportFormats.ts)
 *   tune:   <modify_report_format report_format_id="…">…                →
 *           active/name/summary/param, applied every deploy
 *   remove: <delete_report_format … ultimate="1"/> for a PREVIOUSLY tracked
 *           item id no longer declared on the canvas — ONLY when this app
 *           owns that format's lifecycle (it cloned it); a format the
 *           operator pointed at by an existing UUID is NEVER deleted, even if
 *           its canvas item is removed (see _shared.ts's module doc).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential || !credential.username || !credential.password) {
    return { success: false, message: 'Greenbone deploy needs a connection credential with a username and password.' }
  }

  const specs = extractSpecs(items).filter((s) => s.itemId && (s.reportFormatId || s.cloneFrom))
  const newEntries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let removed = 0

  try {
    return await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component) },
      { username: credential.username, password: credential.password },
      async (session) => {
        const live = await listReportFormats(session)
        const liveById = new Map(live.map((r) => [r.id, r]))
        const prior = await loadPriorEntries(ctx.platform, canvas)
        const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

        for (const spec of specs) {
          const priorEntry = priorByItemId.get(spec.itemId)
          let targetId = spec.reportFormatId || priorEntry?.reportFormatId || ''
          let ownedByClone = priorEntry?.ownedByClone ?? false
          let priorSnapshot: RollbackEntry['prior'] = null

          const liveMatch = targetId ? liveById.get(targetId) : undefined
          if (targetId && !liveMatch) {
            if (spec.reportFormatId) {
              // The operator explicitly named an id — it must exist; do not silently clone something else.
              throw new GmpError(`report format "${spec.reportFormatId}" was not found on gvmd`)
            }
            targetId = '' // a previously-cloned format vanished out-of-band; fall through to re-clone
          }

          if (targetId && liveMatch) {
            priorSnapshot = {
              name: liveMatch.name,
              summary: liveMatch.summary,
              active: liveMatch.active,
              params: Object.entries(liveMatch.params).map(([name, value]) => ({ name, value })),
            }
          } else {
            if (!spec.cloneFrom) throw new GmpError('report format has neither an existing id nor a clone source')
            const raw = await session.send(buildCreateReportFormatCommand(spec.cloneFrom))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_report_format failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            targetId = newId
            ownedByClone = true
            priorSnapshot = null
            created++
          }

          const tuneStatus = parseGmpStatus(
            await session.send(
              buildModifyReportFormatCommand(targetId, {
                name: spec.name || undefined,
                summary: spec.summary || undefined,
                active: spec.active,
                params: spec.params,
              }),
            ),
          )
          if (!tuneStatus.ok) throw new GmpError(`modify_report_format failed (status ${tuneStatus.status}: ${tuneStatus.statusText})`, tuneStatus.status, tuneStatus.statusText)
          if (priorSnapshot !== null) updated++

          newEntries.push({ itemId: spec.itemId, reportFormatId: targetId, ownedByClone, prior: priorSnapshot })
        }

        const declaredItemIds = new Set(specs.map((s) => s.itemId))
        for (const p of prior) {
          if (declaredItemIds.has(p.itemId) || !p.ownedByClone) continue
          const st = parseGmpStatus(await session.send(buildDeleteReportFormatCommand(p.reportFormatId, true)))
          if (st.ok) removed++
        }

        return {
          success: true,
          message: `Reconciled ${specs.length} report format(s): ${created} cloned, ${updated} tuned, ${removed} removed.`,
          artifacts: { created, updated, removed },
          rollbackData: { previous: newEntries },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Report format deploy failed after ${created} cloned, ${updated} tuned, ${removed} removed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { created, updated, removed },
      rollbackData: { previous: newEntries },
    }
  }
}
