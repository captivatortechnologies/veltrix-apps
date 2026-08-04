import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus } from '../../lib/greenboneApi'
import { buildDeleteFilterCommand, buildModifyFilterCommand } from '../../lib/gmp/filters'

/**
 * Undo a filters deploy from rollbackData.previous (written by deploy()): for
 * each entry, either DELETE the filter we created (<delete_filter
 * ultimate="1"/>) or RESTORE the prior fields on one we modified
 * (<modify_filter>). Best-effort — a failed step is counted and reported
 * rather than aborting the rest. NOTE: gvmd refuses to delete a filter still
 * referenced elsewhere (e.g. an alert condition); that is counted as failed.
 * Applied over GMP (XML over TLS, 9390).
 */
interface Prior {
  name: string
  filterId: string
  created: boolean
  restore: { name: string; type: string; term: string; comment: string } | null
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
              const st = parseGmpStatus(await session.send(buildDeleteFilterCommand(entry.filterId, true)))
              st.ok ? deleted++ : failed++
            } else if (entry.restore) {
              const st = parseGmpStatus(
                await session.send(
                  buildModifyFilterCommand(entry.filterId, { name: entry.restore.name, type: entry.restore.type, term: entry.restore.term, comment: entry.restore.comment }),
                ),
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
      message: `Rolled back filters: ${deleted} deleted, ${restored} restored${failed ? `, ${failed} failed` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
