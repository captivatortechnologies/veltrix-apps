import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { type FeatureRollbackEntry } from './deploy'

/**
 * Roll back feature toggles using the state captured during deploy. Nothing is
 * ever created (features are update-only), so there is nothing to delete — each
 * feature is simply returned to its prior lifecycle status by replaying that
 * lifecycle (POST /features/{id}/ENABLE|DISABLE). The replay is idempotent, so a
 * feature already at its prior status is a no-op. `?mode=force` is sent so the
 * restore overrides any dependency/dependent restriction the deploy introduced.
 * A 404 (feature gone) is tolerated.
 *
 * Rollback is keyed on the feature id Okta returned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: FeatureRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const restored: string[] = []

  try {
    for (const entry of previousState) {
      // A blank prior status means we never learned a state to restore — skip it.
      if (!entry.id || !entry.priorStatus) {
        restored.push(entry.name)
        continue
      }

      const lifecycle = entry.priorStatus.toUpperCase() === 'ENABLED' ? 'ENABLE' : 'DISABLE'
      const res = await client.request('POST', `/features/${entry.id}/${lifecycle}`, {
        query: { mode: 'force' },
      })
      if (!res.ok && res.status !== 404) {
        throw new Error(
          `Failed to restore feature "${entry.name}" to ${entry.priorStatus}: ${oktaErrorMessage(res)}`,
        )
      }
      restored.push(entry.name)
    }

    return {
      success: true,
      message: `Restored ${restored.length} feature toggle(s) to their prior state: ${restored.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${restored.length} of ${previousState.length} feature(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
