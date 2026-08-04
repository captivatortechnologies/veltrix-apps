import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, type Sgt } from '../../lib/iseApi'
import type { RollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previous = ((ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }).previous ?? []
  if (!previous.length) return { success: true, message: 'Nothing to roll back.' }
  if (!hasUsableCredential(ctx.credential)) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildErsResourceClient<Sgt>(ersBase(ctx.component, ctx.connectivity, ctx.connectivityProvider), 'sgt', 'Sgt', ctx.credential, readIseSettings(ctx.settings))
  let restored = 0, deleted = 0, skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.id) { skipped++; continue }
      if (entry.sgt) {
        await client.update(entry.id, {
          name: entry.sgt.name ?? entry.name,
          description: entry.sgt.description ?? '',
          value: entry.sgt.value,
          propogateToApic: entry.sgt.propogateToApic,
        })
        restored++
      } else { await client.remove(entry.id); deleted++ }
    }
    return { success: true, message: `Rolled back Security Group Tags: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
