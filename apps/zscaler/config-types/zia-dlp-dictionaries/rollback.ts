import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { DlpDictionaryRollbackEntry } from './deploy'

/**
 * Roll back ZIA DLP dictionaries using the state captured during deploy:
 *   - dictionaries that were created are deleted (DELETE /dlpDictionaries/{id})
 *   - dictionaries that were updated are restored (PUT) to their prior body
 * Predefined dictionaries are never captured (deploy refuses to touch them), so
 * rollback only ever reverts custom dictionaries. Reverting is itself a staged
 * change, so this activates once at the end.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DlpDictionaryRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse order so newer changes are undone first.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zia('DELETE', `/dlpDictionaries/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete DLP dictionary "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const restore: Record<string, unknown> = {
          name: entry.prior.name ?? entry.name,
          description: entry.prior.description ?? '',
          dictionaryType: entry.prior.dictionaryType,
          phrases: entry.prior.phrases ?? [],
          patterns: entry.prior.patterns ?? [],
          customPhraseMatchType: entry.prior.customPhraseMatchType,
          custom: true,
        }
        const res = await client.zia('PUT', `/dlpDictionaries/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore DLP dictionary "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Reverted ${reverted.length} DLP dictionary(ies) but activation failed: ${zscalerErrorMessage(
          act,
        )}. Re-run rollback to retry activation.`,
      }
    }

    return {
      success: true,
      message: `Rolled back and activated ${reverted.length} ZIA DLP dictionary(ies): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} dictionary(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
