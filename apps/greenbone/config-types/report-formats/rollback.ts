import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus } from '../../lib/greenboneApi'
import { buildDeleteReportFormatCommand, buildModifyReportFormatCommand } from '../../lib/gmp/reportFormats'
import type { RollbackEntry } from './_shared'

/**
 * Undo a report-formats deploy from rollbackData.previous (written by
 * deploy()), in reverse order: RESTORE the prior name/summary/active/params
 * on an entry that had a snapshot, or DELETE an entry that had none (this app
 * cloned it fresh this run). Best-effort — a failed step is counted and
 * reported. A format the operator pointed at by an EXISTING id (never
 * cloned by this app) is only ever restored, never deleted — see
 * _shared.ts's module doc. Applied over GMP (XML over TLS, 9390).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential || !credential.username || !credential.password) {
    return { success: false, message: 'Greenbone rollback needs a connection credential with a username and password.' }
  }

  let restored = 0
  let deleted = 0
  let failed = 0

  try {
    await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component) },
      { username: credential.username, password: credential.password },
      async (session) => {
        for (const entry of [...previous].reverse()) {
          try {
            if (entry.prior) {
              const st = parseGmpStatus(
                await session.send(buildModifyReportFormatCommand(entry.reportFormatId, { name: entry.prior.name, summary: entry.prior.summary, active: entry.prior.active, params: entry.prior.params })),
              )
              st.ok ? restored++ : failed++
            } else if (entry.ownedByClone) {
              const st = parseGmpStatus(await session.send(buildDeleteReportFormatCommand(entry.reportFormatId, true)))
              st.ok ? deleted++ : failed++
            }
          } catch {
            failed++
          }
        }
      },
    )
    return { success: failed === 0, message: `Rolled back report formats: ${restored} restored, ${deleted} deleted${failed ? `, ${failed} failed` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
