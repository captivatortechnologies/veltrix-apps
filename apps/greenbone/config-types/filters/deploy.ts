import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus, parseCreatedId, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildGetFiltersCommand, buildCreateFilterCommand, buildModifyFilterCommand, parseFilters } from '../../lib/gmp/filters'
import { buildFilterInput, findFilterByName } from './_shared'

/**
 * Deploy Greenbone filters over GMP (XML over TLS, 9390):
 *   read:   <get_filters filter="rows=-1"/>        → find by name
 *   create: <create_filter>…</create_filter>       → new id on the response
 *   update: <modify_filter filter_id="…">…          (filter already exists)
 *
 * The filter NAME is the stable identity used to upsert. rollbackData
 * records, per filter, whether we CREATED it (rollback deletes it) or
 * MODIFIED an existing one (recording the prior fields so rollback can
 * restore them).
 */
interface Prior {
  name: string
  filterId: string
  created: boolean
  restore: { name: string; type: string; term: string; comment: string } | null
}

async function listFilters(session: GmpSession) {
  return parseFilters(await session.send(buildGetFiltersCommand()))
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential || !credential.username || !credential.password) {
    return { success: false, message: 'Greenbone deploy needs a connection credential with a username and password.' }
  }

  const previous: Prior[] = []
  const applied: string[] = []

  try {
    return await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component) },
      { username: credential.username, password: credential.password },
      async (session) => {
        const live = await listFilters(session)

        for (const item of items) {
          const input = buildFilterInput(item.fields)
          if (!input.name) continue

          const existing = findFilterByName(live, input.name)
          if (existing) {
            const st = parseGmpStatus(await session.send(buildModifyFilterCommand(existing.id, input)))
            if (!st.ok) throw new GmpError(`modify_filter "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({
              name: input.name,
              filterId: existing.id,
              created: false,
              restore: { name: existing.name, type: existing.type, term: existing.term, comment: existing.comment },
            })
          } else {
            const raw = await session.send(buildCreateFilterCommand(input))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_filter "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({ name: input.name, filterId: newId, created: true, restore: null })
          }
          applied.push(input.name)
        }

        return {
          success: true,
          message: `Applied ${applied.length} filter(s): ${applied.join(', ') || '(none)'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Filter deploy failed after ${applied.length} filter(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
