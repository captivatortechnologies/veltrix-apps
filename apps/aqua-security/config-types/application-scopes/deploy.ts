import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAquaClient, type AquaApplicationScope } from '../../lib/aquasec'
import { buildApplicationScopeBody, extractApplicationScopeSpecs } from './_shared'
import type { RollbackEntry } from '../lib/common'

/**
 * Deploy Aqua application scopes over the Console REST API:
 *   find:    GET    /api/v2/access_management/scopes/<name>
 *   create:  POST   /api/v2/access_management/scopes
 *   update:  PUT    /api/v2/access_management/scopes/<name>
 *   remove:  DELETE /api/v2/access_management/scopes/<name>
 *
 * Every item in the canvas is deployed — remove the item to remove the
 * scope. The scope name is the stable identity used to upsert. Application
 * Scopes are typically referenced by name from other config types
 * (assurance/runtime policies), so deploy this config type before policies
 * that reference a newly-added scope.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const specs = extractApplicationScopeSpecs(ctx.canvas)

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: RollbackEntry<AquaApplicationScope>[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      if (!spec.name) continue

      const existing = await client.getApplicationScope(spec.name)
      const body = buildApplicationScopeBody(spec)

      if (existing) {
        await client.updateApplicationScope(body)
        previous.push({ name: spec.name, action: 'updated', prior: existing })
      } else {
        await client.createApplicationScope(body)
        previous.push({ name: spec.name, action: 'created', prior: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} application scope(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Application scope deploy failed after ${applied.length} scope(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
