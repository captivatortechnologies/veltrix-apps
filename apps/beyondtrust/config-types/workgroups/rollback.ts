import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'

/**
 * Rollback for workgroups. Password Safe exposes NO delete endpoint for a
 * workgroup (the Workgroups resource is GET + POST only), so a workgroup this
 * deploy created cannot be removed via the API. Rather than fail — or pretend to
 * undo — this reports exactly which workgroups were created and remain in place,
 * so an operator can remove them in the BeyondInsight console if needed. Network-
 * free: everything needed is in rollbackData written by deploy().
 */
interface RollbackEntry {
  name: string
  action: 'created' | 'existing'
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const createdNames = (data.previous ?? []).filter((e) => e.action === 'created').map((e) => e.name)

  if (createdNames.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  return {
    success: true,
    message:
      `Password Safe has no delete endpoint for workgroups — ${createdNames.length} workgroup(s) created by this deploy remain and must be removed in the BeyondInsight console: ${createdNames.join(', ')}.`,
  }
}
