import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, type IdentityGroup } from '../../lib/iseApi'
import type { RollbackEntry } from './deploy'

/**
 * Undo a user-identity-groups deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT the prior name/description/parent id back
 * (restore — the parent id was already resolved and captured, so no
 * re-resolution is needed), or — when the group was newly created (prior
 * detail null) — DELETE it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<IdentityGroup>(base, 'identitygroup', 'IdentityGroup', credential, settings)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.id) {
        skipped++
        continue
      }
      if (entry.group) {
        const body: Omit<IdentityGroup, 'id' | 'link'> = { name: entry.group.name ?? entry.name, description: entry.group.description ?? '' }
        if (entry.group.parent) body.parent = entry.group.parent
        await client.update(entry.id, body)
        restored++
      } else {
        await client.remove(entry.id)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back identity groups: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
