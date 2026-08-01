import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigMacro } from '../../lib/sysdigApi'

/**
 * Undo a Falco-macros deploy from rollbackData.previous (written by deploy()).
 * Per entry, reverse the action taken:
 *   created → DELETE the macro we added
 *   updated → PUT the prior macro body back onto the same id (restore)
 *   deleted → POST the prior macro body to re-create it (a new id is assigned)
 *   noop    → nothing to undo
 * Applied over the Sysdig Secure REST API.
 */
type MacroAction = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: MacroAction
  macroId: number | null
  prior: SysdigMacro | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let removed = 0
  let recreated = 0
  let skipped = 0

  try {
    for (const entry of previous) {
      switch (entry.action) {
        case 'created':
          if (entry.macroId != null) {
            await client.deleteFalcoMacro(entry.macroId)
            removed++
          } else {
            skipped++
          }
          break
        case 'updated':
          if (entry.macroId != null && entry.prior) {
            await client.updateFalcoMacro(entry.macroId, { ...entry.prior, id: entry.macroId })
            restored++
          } else {
            skipped++
          }
          break
        case 'deleted':
          if (entry.prior) {
            const { id: _id, version: _version, ...body } = entry.prior
            await client.createFalcoMacro(body as SysdigMacro)
            recreated++
          } else {
            skipped++
          }
          break
        default:
          skipped++
      }
    }

    return {
      success: true,
      message: `Rolled back Falco macros: ${restored} restored, ${recreated} re-created, ${removed} removed${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
