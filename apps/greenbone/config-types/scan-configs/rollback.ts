import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus } from '../../lib/greenboneApi'
import { buildDeleteConfigCommand, buildModifyConfigCommand } from '../../lib/gmp/scanConfigs'

/**
 * Undo a scan-configs deploy from rollbackData.previous (written by
 * deploy()): for each entry, either DELETE the config we created
 * (<delete_config ultimate="1"/>) or RESTORE the prior name/comment on one we
 * modified (<modify_config>). Best-effort — a failed step is counted and
 * reported. NOTE: family/NVT selection and preference changes are NOT
 * restorable (this app records no prior snapshot of them — the RNC has no
 * "get current selection" shape simple enough to round-trip reliably, see
 * lib/gmp/scanConfigs.ts's FLAGS) — rollback only reverts name/comment (for a
 * modified config) or removes the config entirely (for one this app created).
 * Applied over GMP (XML over TLS, 9390).
 */
interface Prior {
  name: string
  configId: string
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
              const st = parseGmpStatus(await session.send(buildDeleteConfigCommand(entry.configId, true)))
              st.ok ? deleted++ : failed++
            } else if (entry.restore) {
              const st = parseGmpStatus(
                await session.send(buildModifyConfigCommand(entry.configId, { name: entry.restore.name, comment: entry.restore.comment })),
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
      message: `Rolled back scan configs: ${deleted} deleted, ${restored} restored (name/comment only)${failed ? `, ${failed} failed` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
