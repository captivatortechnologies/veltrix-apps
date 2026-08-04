import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus, parseCreatedId, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildGetGroupsCommand, buildCreateGroupCommand, buildModifyGroupCommand, parseGroups } from '../../lib/gmp/groups'
import { buildGroupInput, findGroupByName } from './_shared'

/**
 * Deploy Greenbone groups over GMP (XML over TLS, 9390):
 *   read:   <get_groups filter="rows=-1"/>       → find by name
 *   create: <create_group>…</create_group>       → new id on the response
 *           (specialsFull is only ever sent HERE — see the FLAG)
 *   update: <modify_group group_id="…">…          (group already exists;
 *           specialsFull cannot be changed via modify — a declared/live
 *           mismatch is surfaced as a deploy note, not silently applied)
 *
 * The group NAME is the stable identity used to upsert. rollbackData records,
 * per group, whether we CREATED it (rollback deletes it) or MODIFIED an
 * existing one (recording the prior fields so rollback can restore them).
 */
interface Prior {
  name: string
  groupId: string
  created: boolean
  restore: { name: string; comment: string; users: string[] } | null
}

async function listGroups(session: GmpSession) {
  return parseGroups(await session.send(buildGetGroupsCommand()))
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential || !credential.username || !credential.password) {
    return { success: false, message: 'Greenbone deploy needs a connection credential with a username and password.' }
  }

  const previous: Prior[] = []
  const applied: string[] = []
  const specialsImmutable: string[] = [] // existing groups whose declared specialsFull differs from the live (create-only) value

  try {
    return await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component) },
      { username: credential.username, password: credential.password },
      async (session) => {
        const live = await listGroups(session)

        for (const item of items) {
          const input = buildGroupInput(item.fields)
          if (!input.name) continue

          const existing = findGroupByName(live, input.name)
          if (existing) {
            const st = parseGmpStatus(await session.send(buildModifyGroupCommand(existing.id, input)))
            if (!st.ok) throw new GmpError(`modify_group "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            if (Boolean(input.specialsFull) !== existing.specialsFull) specialsImmutable.push(input.name)
            previous.push({ name: input.name, groupId: existing.id, created: false, restore: { name: existing.name, comment: existing.comment, users: existing.users } })
          } else {
            const raw = await session.send(buildCreateGroupCommand(input))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_group "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({ name: input.name, groupId: newId, created: true, restore: null })
          }
          applied.push(input.name)
        }

        const immutableNote = specialsImmutable.length
          ? ` — note: ${specialsImmutable.length} existing group(s) have a changed "full access" flag that modify cannot apply (delete + recreate required): ${specialsImmutable.join(', ')}`
          : ''
        return {
          success: true,
          message: `Applied ${applied.length} group(s): ${applied.join(', ') || '(none)'}${immutableNote}`,
          artifacts: { applied, specialsImmutable },
          rollbackData: { previous },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Group deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied, specialsImmutable },
      rollbackData: { previous },
    }
  }
}
