import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildClient, vqlTimeoutMs, userGrantVQL, userGrantPolicyVQL, userDeleteVQL, buildPolicyDelta } from './_shared'
import type { UserRollbackEntry } from './deploy'

/**
 * Undo a users-acls deploy from rollbackData.previous (written by deploy()):
 *   - a user this deploy CREATED (existed=false) → user_delete() (undoes roles
 *     AND custom permissions together, since the whole user is removed)
 *   - a user that existed with known prior roles  → user_grant(prior roles)
 *   - a user that existed but whose roles weren't readable → skipped (flagged
 *     best-effort; gui_users() did not surface roles)
 *   - a user that existed and had custom permissions applied this deploy → the
 *     policy delta is REVERSED: prior permissions restored, anything newly
 *     granted this deploy that wasn't there before is cleared
 * A prior password is never restored (see ./_shared.ts). Applied over the gRPC
 * API (mutual TLS).
 *
 * VERIFY against a live Velociraptor server: user_delete() / user_grant().
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: UserRollbackEntry[] }
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
  let policyRestored = 0
  try {
    for (const { name, existed, roles, permissions, desiredPermissions } of previous) {
      if (!name) continue
      if (!existed) {
        await client.runVQL(userDeleteVQL(name), { timeoutMs })
        deleted++
        continue
      }
      if (roles && roles.length > 0) {
        await client.runVQL(userGrantVQL(name, roles), { timeoutMs })
        restored++
      } else {
        skipped++ // existed but prior roles unknown — best-effort, left as deployed
      }

      const revertPolicy = buildPolicyDelta(permissions ?? [], desiredPermissions)
      if (Object.keys(revertPolicy).length > 0) {
        await client.runVQL(userGrantPolicyVQL(name, revertPolicy), { timeoutMs })
        policyRestored++
      }
    }
    return {
      success: true,
      message: `Rolled back users: ${deleted} deleted, ${restored} role-restored, ${skipped} skipped (prior roles unknown), ${policyRestored} custom-permission-restored.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  } finally {
    await client.close().catch(() => {})
  }
}
