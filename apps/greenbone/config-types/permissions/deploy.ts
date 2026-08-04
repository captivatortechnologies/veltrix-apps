import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus, parseCreatedId, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildGetPermissionsCommand, buildCreatePermissionCommand, buildModifyPermissionCommand, buildDeletePermissionCommand, parsePermissions, type PermissionInput } from '../../lib/gmp/permissions'
import { extractSpecs, loadPriorEntries, type RollbackEntry } from './_shared'

async function listPermissions(session: GmpSession) {
  return parsePermissions(await session.send(buildGetPermissionsCommand()))
}

/**
 * Deploy Greenbone permissions over GMP (XML over TLS, 9390), tracked by the
 * CANVAS ITEM's own stable id (permissions have no name field — see
 * _shared.ts):
 *   read:   <get_permissions filter="rows=-1"/>   → confirm a tracked id is
 *           still live, and snapshot it for rollback BEFORE overwriting it
 *   create: <create_permission>…</create_permission>  → new id on the response
 *   update: <modify_permission permission_id="…">…     (tracked id still live)
 *   remove: <delete_permission … ultimate="1"/> for any PREVIOUSLY tracked
 *           item id that is no longer declared on the canvas (the operator
 *           removed the item) — reconciles the live set to exactly what's
 *           declared, the same "declared item ids" cleanup
 *           apps/pfsense/config-types/static-routes uses.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential || !credential.username || !credential.password) {
    return { success: false, message: 'Greenbone deploy needs a connection credential with a username and password.' }
  }

  const specs = extractSpecs(items).filter((s) => s.itemId && s.name && s.subjectId)
  const newEntries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let removed = 0

  try {
    return await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component) },
      { username: credential.username, password: credential.password },
      async (session) => {
        const live = await listPermissions(session)
        const liveById = new Map(live.map((p) => [p.id, p]))
        const prior = await loadPriorEntries(ctx.platform, canvas)
        const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

        for (const spec of specs) {
          const input: PermissionInput = {
            name: spec.name,
            subjectId: spec.subjectId,
            subjectType: spec.subjectType,
            resourceId: spec.resourceId,
            resourceType: spec.resourceType,
            comment: spec.comment,
          }
          const priorEntry = priorByItemId.get(spec.itemId)
          const liveMatch = priorEntry ? liveById.get(priorEntry.permissionId) : undefined

          if (priorEntry && liveMatch) {
            const st = parseGmpStatus(await session.send(buildModifyPermissionCommand(priorEntry.permissionId, input)))
            if (!st.ok) throw new GmpError(`modify_permission failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            newEntries.push({
              itemId: spec.itemId,
              permissionId: priorEntry.permissionId,
              prior: { name: liveMatch.name, subjectId: liveMatch.subjectId, subjectType: liveMatch.subjectType, resourceId: liveMatch.resourceId, resourceType: liveMatch.resourceType, comment: liveMatch.comment },
            })
            updated++
          } else {
            const raw = await session.send(buildCreatePermissionCommand(input))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_permission failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            newEntries.push({ itemId: spec.itemId, permissionId: newId, prior: null })
            created++
          }
        }

        const declaredItemIds = new Set(specs.map((s) => s.itemId))
        for (const p of prior) {
          if (declaredItemIds.has(p.itemId)) continue
          const st = parseGmpStatus(await session.send(buildDeletePermissionCommand(p.permissionId, true)))
          if (st.ok) removed++
        }

        return {
          success: true,
          message: `Reconciled ${specs.length} permission(s): ${created} created, ${updated} updated, ${removed} removed.`,
          artifacts: { created, updated, removed },
          rollbackData: { previous: newEntries },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Permission deploy failed after ${created} created, ${updated} updated, ${removed} removed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { created, updated, removed },
      rollbackData: { previous: newEntries },
    }
  }
}
