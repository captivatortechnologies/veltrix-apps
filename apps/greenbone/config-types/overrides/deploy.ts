import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus, parseCreatedId, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildGetOverridesCommand, buildCreateOverrideCommand, buildModifyOverrideCommand, buildDeleteOverrideCommand, parseOverrides, type OverrideInput } from '../../lib/gmp/overrides'
import { extractSpecs, loadPriorEntries, type RollbackEntry } from './_shared'

async function listOverrides(session: GmpSession) {
  return parseOverrides(await session.send(buildGetOverridesCommand()))
}

/**
 * Deploy Greenbone overrides over GMP (XML over TLS, 9390), tracked by the
 * CANVAS ITEM's own stable id (overrides have no name field — see
 * _shared.ts):
 *   read:   <get_overrides filter="rows=-1"/>       → confirm a tracked id is
 *           still live, and snapshot it for rollback BEFORE overwriting it
 *   create: <create_override>…</create_override>    → new id on the response
 *   update: <modify_override override_id="…">…        (tracked id still live)
 *   remove: <delete_override … ultimate="1"/> for any PREVIOUSLY tracked item
 *           id no longer declared on the canvas — reconciles the live set to
 *           exactly what's declared.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential || !credential.username || !credential.password) {
    return { success: false, message: 'Greenbone deploy needs a connection credential with a username and password.' }
  }

  const specs = extractSpecs(items).filter((s) => s.itemId && s.text && s.nvtOid && !Number.isNaN(s.newSeverity))
  const newEntries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let removed = 0

  try {
    return await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component) },
      { username: credential.username, password: credential.password },
      async (session) => {
        const live = await listOverrides(session)
        const liveById = new Map(live.map((o) => [o.id, o]))
        const prior = await loadPriorEntries(ctx.platform, canvas)
        const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

        for (const spec of specs) {
          const input: OverrideInput = {
            text: spec.text,
            nvtOid: spec.nvtOid,
            hosts: spec.hosts,
            port: spec.port,
            severity: spec.severity,
            newSeverity: spec.newSeverity,
            daysActive: spec.daysActive,
            taskId: spec.taskId,
            resultId: spec.resultId,
          }
          const priorEntry = priorByItemId.get(spec.itemId)
          const liveMatch = priorEntry ? liveById.get(priorEntry.overrideId) : undefined

          if (priorEntry && liveMatch) {
            const st = parseGmpStatus(await session.send(buildModifyOverrideCommand(priorEntry.overrideId, input)))
            if (!st.ok) throw new GmpError(`modify_override failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            newEntries.push({
              itemId: spec.itemId,
              overrideId: priorEntry.overrideId,
              prior: {
                text: liveMatch.text,
                nvtOid: liveMatch.nvtOid,
                hosts: liveMatch.hosts,
                port: liveMatch.port,
                severity: liveMatch.severity ? Number(liveMatch.severity) : undefined,
                newSeverity: Number(liveMatch.newSeverity) || 0,
                taskId: liveMatch.taskId,
                resultId: liveMatch.resultId,
              },
            })
            updated++
          } else {
            const raw = await session.send(buildCreateOverrideCommand(input))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_override failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            newEntries.push({ itemId: spec.itemId, overrideId: newId, prior: null })
            created++
          }
        }

        const declaredItemIds = new Set(specs.map((s) => s.itemId))
        for (const p of prior) {
          if (declaredItemIds.has(p.itemId)) continue
          const st = parseGmpStatus(await session.send(buildDeleteOverrideCommand(p.overrideId, true)))
          if (st.ok) removed++
        }

        return {
          success: true,
          message: `Reconciled ${specs.length} override(s): ${created} created, ${updated} updated, ${removed} removed.`,
          artifacts: { created, updated, removed },
          rollbackData: { previous: newEntries },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Override deploy failed after ${created} created, ${updated} updated, ${removed} removed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { created, updated, removed },
      rollbackData: { previous: newEntries },
    }
  }
}
