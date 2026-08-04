import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus, parseCreatedId, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildGetNotesCommand, buildCreateNoteCommand, buildModifyNoteCommand, buildDeleteNoteCommand, parseNotes, type NoteInput } from '../../lib/gmp/notes'
import { extractSpecs, loadPriorEntries, type RollbackEntry } from './_shared'

async function listNotes(session: GmpSession) {
  return parseNotes(await session.send(buildGetNotesCommand()))
}

/**
 * Deploy Greenbone notes over GMP (XML over TLS, 9390), tracked by the
 * CANVAS ITEM's own stable id (notes have no name field — see _shared.ts):
 *   read:   <get_notes filter="rows=-1"/>       → confirm a tracked id is
 *           still live, and snapshot it for rollback BEFORE overwriting it
 *   create: <create_note>…</create_note>        → new id on the response
 *   update: <modify_note note_id="…">…            (tracked id still live)
 *   remove: <delete_note … ultimate="1"/> for any PREVIOUSLY tracked item id
 *           no longer declared on the canvas — reconciles the live set to
 *           exactly what's declared.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential || !credential.username || !credential.password) {
    return { success: false, message: 'Greenbone deploy needs a connection credential with a username and password.' }
  }

  const specs = extractSpecs(items).filter((s) => s.itemId && s.text && s.nvtOid)
  const newEntries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let removed = 0

  try {
    return await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component) },
      { username: credential.username, password: credential.password },
      async (session) => {
        const live = await listNotes(session)
        const liveById = new Map(live.map((n) => [n.id, n]))
        const prior = await loadPriorEntries(ctx.platform, canvas)
        const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

        for (const spec of specs) {
          const input: NoteInput = {
            text: spec.text,
            nvtOid: spec.nvtOid,
            hosts: spec.hosts,
            port: spec.port,
            daysActive: spec.daysActive,
            taskId: spec.taskId,
            resultId: spec.resultId,
          }
          const priorEntry = priorByItemId.get(spec.itemId)
          const liveMatch = priorEntry ? liveById.get(priorEntry.noteId) : undefined

          if (priorEntry && liveMatch) {
            const st = parseGmpStatus(await session.send(buildModifyNoteCommand(priorEntry.noteId, input)))
            if (!st.ok) throw new GmpError(`modify_note failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            newEntries.push({
              itemId: spec.itemId,
              noteId: priorEntry.noteId,
              prior: { text: liveMatch.text, nvtOid: liveMatch.nvtOid, hosts: liveMatch.hosts, port: liveMatch.port, taskId: liveMatch.taskId, resultId: liveMatch.resultId },
            })
            updated++
          } else {
            const raw = await session.send(buildCreateNoteCommand(input))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_note failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            newEntries.push({ itemId: spec.itemId, noteId: newId, prior: null })
            created++
          }
        }

        const declaredItemIds = new Set(specs.map((s) => s.itemId))
        for (const p of prior) {
          if (declaredItemIds.has(p.itemId)) continue
          const st = parseGmpStatus(await session.send(buildDeleteNoteCommand(p.noteId, true)))
          if (st.ok) removed++
        }

        return {
          success: true,
          message: `Reconciled ${specs.length} note(s): ${created} created, ${updated} updated, ${removed} removed.`,
          artifacts: { created, updated, removed },
          rollbackData: { previous: newEntries },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Note deploy failed after ${created} created, ${updated} updated, ${removed} removed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { created, updated, removed },
      rollbackData: { previous: newEntries },
    }
  }
}
