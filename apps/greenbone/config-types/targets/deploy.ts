import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, buildGetTargetsCommand, buildCreateTargetCommand, buildModifyTargetCommand, parseGmpStatus, parseCreatedId, parseTargets, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildTargetInput, findTargetByName } from './_shared'

/**
 * Deploy Greenbone scan targets over GMP (XML over TLS, 9390):
 *   read:   <get_targets filter="rows=-1"/>   → find the live target by name
 *   create: <create_target>…</create_target>  → new id returned on the response
 *   update: <modify_target target_id="…">…     (target already exists)
 *
 * The target NAME is the stable identity used to upsert. rollbackData records,
 * per target, whether we CREATED it (so rollback deletes it) or MODIFIED an
 * existing one (recording the prior name/hosts/exclude/comment so rollback can
 * restore it). port_list is set on create; gvmd rejects changing it on a target
 * that is in use, so modify only re-sends name/hosts/exclude/comment.
 */
interface Prior {
  name: string
  targetId: string
  created: boolean
  restore: { name: string; hosts: string; excludeHosts: string; comment: string } | null
}

/** Read every live target (best-effort) for identity matching + rollback snapshots. */
async function listTargets(session: GmpSession) {
  const raw = await session.send(buildGetTargetsCommand())
  return parseTargets(raw)
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
        const live = await listTargets(session)

        for (const item of items) {
          const input = buildTargetInput(item.fields)
          if (!input.name || !input.hosts) continue

          const existing = findTargetByName(live, input.name)
          if (existing) {
            const raw = await session.send(
              buildModifyTargetCommand(existing.id, {
                name: input.name,
                hosts: input.hosts,
                excludeHosts: input.excludeHosts ?? '',
                comment: input.comment ?? '',
              }),
            )
            const st = parseGmpStatus(raw)
            if (!st.ok) throw new GmpError(`modify_target "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({
              name: input.name,
              targetId: existing.id,
              created: false,
              restore: { name: existing.name, hosts: existing.hosts, excludeHosts: existing.excludeHosts, comment: existing.comment },
            })
          } else {
            const raw = await session.send(buildCreateTargetCommand(input))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_target "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({ name: input.name, targetId: newId, created: true, restore: null })
          }
          applied.push(input.name)
        }

        return {
          success: true,
          message: `Applied ${applied.length} scan target(s): ${applied.join(', ') || '(none)'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Scan target deploy failed after ${applied.length} target(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
