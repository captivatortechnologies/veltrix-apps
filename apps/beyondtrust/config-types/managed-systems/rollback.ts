import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'

/**
 * Rollback for managed systems. Password Safe exposes no CONFIRMED delete
 * endpoint for a managed system created via
 * POST /Workgroups/{workgroupId}/ManagedSystems (only a delete for the
 * system's CHILD managed accounts was found in the public API reference) — so
 * a system this deploy created cannot safely be removed via the API. Rather
 * than guess at an unverified delete path against a PAM system that may now
 * hold live managed accounts and secrets, this reports exactly which systems
 * were created and remain in place, so an operator can remove them in the
 * BeyondInsight console if needed. Network-free: everything needed is in
 * rollbackData written by deploy().
 */
interface RollbackEntry {
  workgroupName: string
  systemName: string
  managedSystemId: number | string | null
  action: 'created' | 'existing'
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const createdLabels = (data.previous ?? [])
    .filter((e) => e.action === 'created')
    .map((e) => `${e.workgroupName}/${e.systemName}`)

  if (createdLabels.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  return {
    success: true,
    message:
      `Password Safe has no confirmed delete endpoint for a managed system created this way — ` +
      `${createdLabels.length} system(s) created by this deploy remain and must be removed in the ` +
      `BeyondInsight console if no longer wanted: ${createdLabels.join(', ')}.`,
  }
}
