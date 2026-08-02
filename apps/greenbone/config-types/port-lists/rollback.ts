import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, buildDeletePortListCommand, buildModifyPortListCommand, parseGmpStatus } from '../../lib/greenboneApi'

/**
 * Undo a port-lists deploy from rollbackData.previous (written by deploy()): for
 * each entry, either DELETE the port list we created (<delete_port_list ultimate="1"/>)
 * or RESTORE the prior name/comment on one we modified (<modify_port_list>).
 * Best-effort — a failed step is counted and reported. NOTE: gvmd refuses to delete
 * a port list still referenced by a target (status 400); that is counted as failed.
 * Applied over GMP (XML over TLS, 9390).
 */
interface Prior {
  name: string
  portListId: string
  created: boolean
  restore: { name: string; comment: string } | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const previous = ((ctx.rollbackData ?? {}) as { previous?: Prior[] }).previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential || !credential.username || !credential.password) {
    return { success: false, message: 'Greenbone rollback needs a connection credential with a username and password.' }
  }

  let deleted = 0
  let restored = 0
  let failed = 0

  try {
    await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component) },
      { username: credential.username, password: credential.password },
      async (session) => {
        for (const entry of previous) {
          try {
            if (entry.created) {
              const st = parseGmpStatus(await session.send(buildDeletePortListCommand(entry.portListId, true)))
              st.ok ? deleted++ : failed++
            } else if (entry.restore) {
              const st = parseGmpStatus(
                await session.send(buildModifyPortListCommand(entry.portListId, { name: entry.restore.name, comment: entry.restore.comment })),
              )
              st.ok ? restored++ : failed++
            }
          } catch {
            failed++
          }
        }
      },
    )
    return {
      success: failed === 0,
      message: `Rolled back port lists: ${deleted} deleted, ${restored} restored${failed ? `, ${failed} failed` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
