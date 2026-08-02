import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient, type JamfClient } from '../../lib/jamfApi'
import { buildCategoryBody, categoryKey, extractCategorySpecs, indexCategoriesByName, type LiveCategory } from './validate'

const CATEGORIES_PATH = '/v1/categories'

export interface CategoryRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  /** Full prior category state, captured for a category that already existed (restored on rollback). */
  prior?: LiveCategory
}

interface CreateCategoryResponse {
  id?: string
  href?: string
}

/**
 * Deploy Jamf Pro categories via the modern Jamf Pro API
 * (https://developer.jamf.com/jamf-pro/reference/get_v1-categories,
 * post_v1-categories, put_v1-categories-id).
 *
 * Identity is the category `name`: list every category, match on the name,
 * and either update the existing category (capturing its prior state for
 * rollback) or create a new one. Created ids are captured for rollback
 * (delete on revert).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, apiBase } = built

  const specs = extractCategorySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: CategoryRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listCategories(client, ctx.settings)
    const byName = indexCategoriesByName(existing)

    for (const spec of specs) {
      const label = spec.name
      const key = categoryKey(spec.name)
      const live = byName.get(key)
      const body = buildCategoryBody(spec)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `${CATEGORIES_PATH}/${encodeURIComponent(live.id)}`, body)
        if (res.error) throw new Error(`Failed to update category "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const res = await client.request<CreateCategoryResponse>('POST', CATEGORIES_PATH, body)
        if (res.error) throw new Error(`Failed to create category "${label}": ${res.error}`)
        const id = res.data?.id
        if (!id) throw new Error(`Category "${label}" was created but Jamf Pro returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message:
        `Reconciled ${specs.length} Jamf Pro categor${specs.length === 1 ? 'y' : 'ies'} on ${apiBase}: ` +
        `${created.length} created, ${updated.length} updated.`,
      artifacts: { apiBase, createdCategories: created, updatedCategories: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Category deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { apiBase, createdCategories: created, updatedCategories: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List every Jamf Pro category; throws on error. */
export async function listCategories(client: JamfClient, settings: Record<string, unknown>): Promise<LiveCategory[]> {
  const pageSize = typeof settings.page_size === 'number' && settings.page_size > 0 ? settings.page_size : 100
  const res = await client.listAll<LiveCategory>(CATEGORIES_PATH, pageSize)
  if (res.error) throw new Error(`Failed to list Jamf Pro categories: ${res.error}`)
  return res.nodes
}
