import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, buildGetPortListsCommand, buildCreatePortListCommand, buildModifyPortListCommand, parseGmpStatus, parseCreatedId, parsePortLists, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildPortListInput, findPortListByName } from './_shared'

/**
 * Deploy Greenbone port lists over GMP (XML over TLS, 9390):
 *   read:   <get_port_lists details="1" filter="rows=-1"/>  → find by name
 *   create: <create_port_list>…</create_port_list>          → new id on the response
 *   update: <modify_port_list port_list_id="…">…             (name/comment only)
 *
 * The port-list NAME is the stable identity used to upsert. rollbackData records,
 * per list, whether we CREATED it (rollback deletes it) or MODIFIED an existing one
 * (recording the prior name/comment so rollback can restore them).
 *
 * FLAG (GMP 22.5): modify_port_list cannot change the port RANGES — they are
 * immutable via modify. When the declared range differs from the live one, deploy
 * updates name/comment and reports the range as needing a recreate (also flagged by
 * drift) rather than silently dropping the intended change.
 */
interface Prior {
  name: string
  portListId: string
  created: boolean
  restore: { name: string; comment: string } | null
}

async function listPortLists(session: GmpSession) {
  return parsePortLists(await session.send(buildGetPortListsCommand()))
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential || !credential.username || !credential.password) {
    return { success: false, message: 'Greenbone deploy needs a connection credential with a username and password.' }
  }

  const previous: Prior[] = []
  const applied: string[] = []
  const rangeImmutable: string[] = [] // existing lists whose declared range differs (recreate needed)

  try {
    return await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component) },
      { username: credential.username, password: credential.password },
      async (session) => {
        const live = await listPortLists(session)

        for (const item of items) {
          const input = buildPortListInput(item.fields)
          if (!input.name || !input.portRange) continue

          const existing = findPortListByName(live, input.name)
          if (existing) {
            const st = parseGmpStatus(
              await session.send(buildModifyPortListCommand(existing.id, { name: input.name, comment: input.comment ?? '' })),
            )
            if (!st.ok) throw new GmpError(`modify_port_list "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            if (existing.portRange !== input.portRange) rangeImmutable.push(input.name)
            previous.push({ name: input.name, portListId: existing.id, created: false, restore: { name: existing.name, comment: existing.comment } })
          } else {
            const raw = await session.send(buildCreatePortListCommand(input))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_port_list "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({ name: input.name, portListId: newId, created: true, restore: null })
          }
          applied.push(input.name)
        }

        const immutableNote = rangeImmutable.length
          ? ` — note: ${rangeImmutable.length} existing list(s) have a changed port range that modify cannot apply (recreate required): ${rangeImmutable.join(', ')}`
          : ''
        return {
          success: true,
          message: `Applied ${applied.length} port list(s): ${applied.join(', ') || '(none)'}${immutableNote}`,
          artifacts: { applied, rangeImmutable },
          rollbackData: { previous },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Port-list deploy failed after ${applied.length} list(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied, rangeImmutable },
      rollbackData: { previous },
    }
  }
}
