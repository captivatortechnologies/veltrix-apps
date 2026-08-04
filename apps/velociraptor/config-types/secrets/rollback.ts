import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildClient, vqlTimeoutMs, secretModifyVQL } from './_shared'
import type { SecretRollbackEntry } from './deploy'

/**
 * Undo a secrets deploy from rollbackData.previous (written by deploy()):
 *   - a secret this deploy CREATED (existed=false) → secret_modify(delete=true)
 *   - a secret that existed → its grant DELTA is reversed (users/orgs added by
 *     this deploy are removed, users/orgs removed are re-added; visibility is
 *     restored when it was known before)
 * The secret's CONTENT is never restored — Velociraptor's secrets API does not
 * return it, so there is nothing to roll back to (same limitation as an
 * authored password field; see ./_shared.ts). Applied over the gRPC API
 * (mutual TLS).
 *
 * VERIFY against a live Velociraptor server: secret_modify() (see ./_shared.ts).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: SecretRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for secrets rollback' }
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
  try {
    for (const entry of previous) {
      if (!entry.existed) {
        await client.runVQL(secretModifyVQL(entry.name, entry.type, { delete: true }), { timeoutMs })
        deleted++
        continue
      }
      await client.runVQL(
        secretModifyVQL(entry.name, entry.type, {
          addUsers: entry.removedUsers,
          removeUsers: entry.addedUsers,
          addOrgs: entry.removedOrgs,
          removeOrgs: entry.addedOrgs,
          ...(entry.priorVisibleToAllOrgs !== null ? { visibleToAllOrgs: entry.priorVisibleToAllOrgs } : {}),
        }),
        { timeoutMs },
      )
      restored++
    }
    return {
      success: true,
      message: `Rolled back secrets: ${deleted} deleted, ${restored} grant(s) restored. Content changes are never reverted (never readable).`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${deleted + restored} of ${previous.length} secret(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  } finally {
    await client.close().catch(() => {})
  }
}
