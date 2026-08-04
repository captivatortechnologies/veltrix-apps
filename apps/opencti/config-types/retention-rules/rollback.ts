import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_RETENTION_RULE_MUTATION, PATCH_RETENTION_RULE_MUTATION, buildRestorePatch, type OpenctiRetentionRule } from './_shared'

/**
 * Undo a retention-rules deploy from rollbackData.previous (written by
 * deploy()): for each entry with a prior body, retentionRuleEdit(id) {
 * fieldPatch(input) } restores it; a newly created rule (prior body null) is
 * deleted via retentionRuleEdit(id) { delete }. Applied over the OpenCTI
 * GraphQL API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; ruleId: string | null; rule: OpenctiRetentionRule | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for retention-rule rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { ruleId, rule } of previous) {
      if (ruleId == null) {
        // A created rule whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (rule) {
        const input = buildRestorePatch(rule)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_RETENTION_RULE_MUTATION, { id: ruleId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_RETENTION_RULE_MUTATION, { id: ruleId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back retention rules: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
