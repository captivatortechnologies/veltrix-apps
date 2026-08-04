import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_ROLE_MUTATION, PATCH_ROLE_MUTATION, buildRestorePatch, type OpenctiRole } from './_shared'

/**
 * Undo a roles deploy from rollbackData.previous (written by deploy()): for each
 * entry with a prior body, roleEdit(id) { fieldPatch(input) } restores it; a newly
 * created role (prior body null) is deleted via roleEdit(id) { delete }. Applied
 * over the OpenCTI GraphQL API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; roleId: string | null; role: OpenctiRole | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for role rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { roleId, role } of previous) {
      if (roleId == null) {
        // A created role whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (role) {
        const input = buildRestorePatch(role)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_ROLE_MUTATION, { id: roleId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_ROLE_MUTATION, { id: roleId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back roles: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
