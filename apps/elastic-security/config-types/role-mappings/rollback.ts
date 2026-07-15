import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import type { LiveRoleMapping } from './validate'
import type { MappingRollbackEntry } from './deploy'

/**
 * Roll back role mappings using the state captured during deploy:
 *   - mappings that were CREATED are deleted (DELETE /_security/role_mapping/{name});
 *     a 404 means it is already gone, which is the desired end state.
 *   - mappings that were UPDATED are restored (PUT) to their captured prior body.
 *
 * Only native (API-defined), non-reserved mappings are ever in the rollback set —
 * deploy fails before capturing anything when a name collides with a reserved
 * mapping.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: MappingRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this mapping — remove it. 404 means it is already gone
        // (or was never created), which is the desired end state.
        const res = await client.elasticsearch(
          'DELETE',
          `/_security/role_mapping/${encodeURIComponent(entry.name)}`,
        )
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete role mapping "${entry.name}": ${elasticErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        // Deploy replaced this mapping — restore the captured prior body (upsert).
        const res = await client.elasticsearch(
          'PUT',
          `/_security/role_mapping/${encodeURIComponent(entry.name)}`,
          { body: buildRestoreBody(entry.prior) },
        )
        if (!res.ok) {
          throw new Error(`Failed to restore role mapping "${entry.name}": ${elasticErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} role mapping(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} mapping(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/**
 * Rebuild the upsert body from a captured prior mapping. A mapping must grant
 * exactly one of roles / role_templates, so restore whichever form the prior
 * mapping used; its full metadata (including any `_`-prefixed keys) is restored
 * verbatim so the mapping returns to its exact previous state.
 */
function buildRestoreBody(prior: LiveRoleMapping): Record<string, unknown> {
  const body: Record<string, unknown> = {
    enabled: prior.enabled ?? true,
    rules: prior.rules ?? {},
  }
  if (Array.isArray(prior.role_templates) && prior.role_templates.length > 0) {
    body.role_templates = prior.role_templates
  } else {
    body.roles = prior.roles ?? []
  }
  if (prior.metadata) body.metadata = prior.metadata
  return body
}
