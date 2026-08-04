import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import type { LiveComponentTemplateEntry } from './validate'
import type { ComponentTemplateRollbackEntry } from './deploy'

/**
 * Roll back component templates using the state captured during deploy:
 *   - templates that were CREATED are deleted (DELETE /_component_template/{name});
 *     a 404 means it is already gone, which is the desired end state.
 *   - templates that were UPDATED are restored (PUT) to their prior body.
 *
 * DELETE fails if the template is still referenced by a composable index
 * template — that error is surfaced rather than swallowed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ComponentTemplateRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.elasticsearch('DELETE', `/_component_template/${encodeURIComponent(entry.name)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(
            `Failed to delete component template "${entry.name}" (it may still be referenced by an index template): ${elasticErrorMessage(res)}`,
          )
        }
      } else if (entry.prior) {
        const res = await client.elasticsearch('PUT', `/_component_template/${encodeURIComponent(entry.name)}`, {
          body: buildRestoreBody(entry.prior),
        })
        if (!res.ok) {
          throw new Error(`Failed to restore component template "${entry.name}": ${elasticErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} component template(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} template(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild the upsert body from a captured prior entry, restoring it verbatim. */
function buildRestoreBody(prior: LiveComponentTemplateEntry): Record<string, unknown> {
  const ct = prior.component_template ?? {}
  const body: Record<string, unknown> = { template: ct.template ?? {}, deprecated: ct.deprecated === true }
  if (ct.version !== undefined) body.version = ct.version
  if (ct._meta) body._meta = ct._meta
  return body
}
