import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { createRule, deleteRule, type IdpRuleRollbackEntry } from './deploy'

/**
 * Roll back Identity Protection policy rules using the state captured during
 * deploy. Because the API has NO update endpoint, rollback — like deploy —
 * works REPLACE-IN-PLACE:
 *   - rules the deploy CREATED are deleted.
 *   - rules the deploy REPLACED (delete + recreate) are reverted by deleting
 *     what we created and recreating the prior rule from its captured body.
 *   - rules the deploy left unchanged (no-op) are not touched.
 *
 * Recreated prior rules come back under a FRESH id — the original id cannot be
 * preserved (there is no way to set an id on create). Identity is by name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IdpRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse deploy order so precedence-driven creation is undone last-in-first-out.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        // Deploy created this rule fresh — remove it.
        if (entry.createdId) await deleteRule(client, entry.createdId)
      } else if (entry.replaced) {
        // Deploy replaced this rule — delete what we created, then recreate the
        // prior rule, but ONLY if the prior was actually deleted (otherwise it
        // still exists and recreating would duplicate it).
        if (entry.createdId) await deleteRule(client, entry.createdId)
        if (entry.deleted && entry.priorRule) {
          await recreatePriorRule(client, entry)
        }
      }
      // existed && !replaced → deploy was a no-op for this rule; leave it alone.

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} Identity Protection policy rule(s): ${reverted.join(', ')}. Note: replaced rules were recreated under new ids (the API cannot preserve ids).`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

async function recreatePriorRule(
  client: Parameters<typeof createRule>[0],
  entry: IdpRuleRollbackEntry,
): Promise<void> {
  try {
    await createRule(client, entry.name, entry.priorRule as Record<string, unknown>)
  } catch (error) {
    throw new Error(
      `Failed to recreate prior rule "${entry.name}": ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
}
