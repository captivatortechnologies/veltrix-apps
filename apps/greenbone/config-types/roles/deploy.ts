import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus, parseCreatedId, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildGetRolesCommand, buildCreateRoleCommand, buildModifyRoleCommand, parseRoles } from '../../lib/gmp/roles'
import { buildRoleInput, findRoleByName, PREDEFINED_ROLE_NAMES } from './_shared'

/**
 * Deploy Greenbone (custom) roles over GMP (XML over TLS, 9390):
 *   read:   <get_roles filter="rows=-1"/>       → find by name (predefined
 *           roles are excluded from matching — see _shared.ts)
 *   create: <create_role>…</create_role>        → new id on the response
 *   update: <modify_role role_id="…">…           (role already exists)
 *
 * The role NAME is the stable identity used to upsert. A declared name
 * matching a predefined role is skipped (validate.ts already rejects it, but
 * deploy defends the same rule in case validate was bypassed). rollbackData
 * records, per role, whether we CREATED it (rollback deletes it) or MODIFIED
 * an existing one (recording the prior fields so rollback can restore them).
 */
interface Prior {
  name: string
  roleId: string
  created: boolean
  restore: { name: string; comment: string; users: string[] } | null
}

async function listRoles(session: GmpSession) {
  return parseRoles(await session.send(buildGetRolesCommand()))
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential || !credential.username || !credential.password) {
    return { success: false, message: 'Greenbone deploy needs a connection credential with a username and password.' }
  }

  const previous: Prior[] = []
  const applied: string[] = []
  const skippedPredefined: string[] = []

  try {
    return await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component) },
      { username: credential.username, password: credential.password },
      async (session) => {
        const live = await listRoles(session)

        for (const item of items) {
          const input = buildRoleInput(item.fields)
          if (!input.name) continue
          if (PREDEFINED_ROLE_NAMES.has(input.name)) {
            skippedPredefined.push(input.name)
            continue
          }

          const existing = findRoleByName(live, input.name)
          if (existing) {
            const st = parseGmpStatus(await session.send(buildModifyRoleCommand(existing.id, input)))
            if (!st.ok) throw new GmpError(`modify_role "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({ name: input.name, roleId: existing.id, created: false, restore: { name: existing.name, comment: existing.comment, users: existing.users } })
          } else {
            const raw = await session.send(buildCreateRoleCommand(input))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_role "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({ name: input.name, roleId: newId, created: true, restore: null })
          }
          applied.push(input.name)
        }

        const skippedNote = skippedPredefined.length ? ` — skipped ${skippedPredefined.length} predefined role name(s): ${skippedPredefined.join(', ')}` : ''
        return {
          success: true,
          message: `Applied ${applied.length} role(s): ${applied.join(', ') || '(none)'}${skippedNote}`,
          artifacts: { applied, skippedPredefined },
          rollbackData: { previous },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Role deploy failed after ${applied.length} role(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied, skippedPredefined },
      rollbackData: { previous },
    }
  }
}
