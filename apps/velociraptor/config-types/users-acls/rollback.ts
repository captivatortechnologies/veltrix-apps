import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildClient, vqlTimeoutMs, userGrantVQL, userDeleteVQL } from './_shared'

/**
 * Undo a users-acls deploy from rollbackData.previous (written by deploy()):
 *   - a user this deploy CREATED (existed=false) → user_delete()
 *   - a user that existed with known prior roles  → user_grant(prior roles)
 *   - a user that existed but whose roles weren't readable → skipped (flagged
 *     best-effort; gui_users() did not surface roles). A prior password is never
 *     restored.
 * Applied over the gRPC API (mutual TLS).
 *
 * VERIFY against a live Velociraptor server: user_delete() / user_grant().
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; existed: boolean; roles: string[] | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for users-acls rollback' }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  let deleted = 0
  let restored = 0
  let skipped = 0
  try {
    for (const { name, existed, roles } of previous) {
      if (!name) continue
      if (!existed) {
        await client.runVQL(userDeleteVQL(name), { timeoutMs })
        deleted++
      } else if (roles && roles.length > 0) {
        await client.runVQL(userGrantVQL(name, roles), { timeoutMs })
        restored++
      } else {
        skipped++ // existed but prior roles unknown — best-effort, left as deployed
      }
    }
    return {
      success: true,
      message: `Rolled back users: ${deleted} deleted, ${restored} role-restored, ${skipped} skipped (prior roles unknown).`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  } finally {
    await client.close().catch(() => {})
  }
}
