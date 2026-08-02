import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, buildDeleteTaskCommand, buildModifyTaskCommand, parseGmpStatus } from '../../lib/greenboneApi'

/**
 * Undo a scan-tasks deploy from rollbackData.previous (written by deploy()): for
 * each entry, either DELETE the task we created (<delete_task ultimate="1"/>) or
 * RESTORE the prior name/comment/config/target/scanner/schedule on a task we
 * modified (<modify_task>). Best-effort — a failed step is counted and reported.
 * FLAG: restoring config/target/scanner may be refused by gvmd on a task that has
 * run (gvmd #1305); such a step is counted as failed rather than aborting the rest.
 * Applied over GMP (XML over TLS, 9390).
 */
interface Prior {
  name: string
  taskId: string
  created: boolean
  restore: { name: string; comment: string; configId: string; targetId: string; scannerId: string; scheduleId: string } | null
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
              const st = parseGmpStatus(await session.send(buildDeleteTaskCommand(entry.taskId, true)))
              st.ok ? deleted++ : failed++
            } else if (entry.restore) {
              const st = parseGmpStatus(
                await session.send(
                  buildModifyTaskCommand(entry.taskId, {
                    name: entry.restore.name,
                    comment: entry.restore.comment,
                    configId: entry.restore.configId,
                    targetId: entry.restore.targetId,
                    scannerId: entry.restore.scannerId,
                    scheduleId: entry.restore.scheduleId || '0',
                  }),
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
      message: `Rolled back scan tasks: ${deleted} deleted, ${restored} restored${failed ? `, ${failed} failed` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
