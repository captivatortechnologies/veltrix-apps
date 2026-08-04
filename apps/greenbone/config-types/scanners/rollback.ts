import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus } from '../../lib/greenboneApi'
import { buildDeleteScannerCommand, buildModifyScannerCommand } from '../../lib/gmp/scanners'

/**
 * Undo a scanners deploy from rollbackData.previous (written by deploy()): for
 * each entry, either DELETE the scanner we created (<delete_scanner
 * ultimate="1"/>) or RESTORE the prior fields on one we modified
 * (<modify_scanner>). Best-effort — a failed step is counted and reported
 * rather than aborting the rest. Applied over GMP (XML over TLS, 9390).
 */
interface Prior {
  name: string
  scannerId: string
  created: boolean
  restore: { name: string; host: string; port: number; type: string; caPub: string; credentialId: string; comment: string } | null
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
              const st = parseGmpStatus(await session.send(buildDeleteScannerCommand(entry.scannerId, true)))
              st.ok ? deleted++ : failed++
            } else if (entry.restore) {
              const st = parseGmpStatus(await session.send(buildModifyScannerCommand(entry.scannerId, entry.restore)))
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
      message: `Rolled back scanners: ${deleted} deleted, ${restored} restored${failed ? `, ${failed} failed` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
