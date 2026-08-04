import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus, parseCreatedId, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildGetTagsCommand, buildCreateTagCommand, buildModifyTagCommand, parseTags, type TagInput } from '../../lib/gmp/tags'
import { buildTagInput, findTagByName } from './_shared'

/**
 * Deploy Greenbone tags over GMP (XML over TLS, 9390):
 *   read:   <get_tags filter="rows=-1"/>        → find by name
 *   create: <create_tag>…</create_tag>          → new id on the response
 *   update: <modify_tag tag_id="…">…             (resources sent with
 *           action="set" — a full replace of the attached resource list)
 *
 * The tag NAME is the app-level identity used to upsert (gvmd itself allows
 * duplicate names — see lib/gmp/tags.ts's FLAGS). rollbackData records, per
 * tag, whether we CREATED it (rollback deletes it) or MODIFIED an existing
 * one (recording the prior fields so rollback can restore them — the
 * PREVIOUS resource attachment list is not independently re-verified on read,
 * see lib/gmp/tags.ts, so rollback restores name/value/comment/active and
 * resource-type but not necessarily the exact prior attachment set).
 */
interface Prior {
  name: string
  tagId: string
  created: boolean
  restore: (TagInput & { resourceIds: string[] }) | null
}

async function listTags(session: GmpSession) {
  return parseTags(await session.send(buildGetTagsCommand()))
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
        const live = await listTags(session)

        for (const item of items) {
          const input = buildTagInput(item.fields)
          if (!input.name || !input.resourceType) continue

          const existing = findTagByName(live, input.name)
          if (existing) {
            const st = parseGmpStatus(await session.send(buildModifyTagCommand(existing.id, input)))
            if (!st.ok) throw new GmpError(`modify_tag "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({
              name: input.name,
              tagId: existing.id,
              created: false,
              restore: { name: existing.name, resourceType: existing.resourceType, resourceIds: [], value: existing.value, comment: existing.comment, active: existing.active },
            })
          } else {
            const raw = await session.send(buildCreateTagCommand(input))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_tag "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({ name: input.name, tagId: newId, created: true, restore: null })
          }
          applied.push(input.name)
        }

        return {
          success: true,
          message: `Applied ${applied.length} tag(s): ${applied.join(', ') || '(none)'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Tag deploy failed after ${applied.length} tag(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
