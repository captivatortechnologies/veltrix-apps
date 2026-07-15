import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import { extractUrlCategorySpecs, type LiveUrlCategory, type UrlCategorySpec } from './validate'

export interface UrlCategoryRollbackEntry {
  configuredName: string
  existed: boolean
  /** STRING id ("CUSTOM_xx") — this type deviates from the numeric-id references. */
  id?: string
  prior?: {
    configuredName?: string
    superCategory?: string
    type?: string
    urls?: string[]
    keywords?: string[]
    description?: string
  }
}

/**
 * Deploy custom ZIA URL categories via the Zscaler OneAPI.
 *
 * Identity is the `configuredName` (ZIA has no upsert): list /urlCategories,
 * match by configuredName, then PUT an existing category or POST a new one. ZIA
 * STAGES every write — nothing takes effect until activation — so this writes
 * all categories, then calls activate() ONCE at the end. If activation fails the
 * writes remain staged and rollbackData is returned so the platform can revert
 * them.
 *
 * PREDEFINED URL categories are read-only: if a configuredName matches a live
 * category whose `customCategory` is not true, deploy throws so the author
 * renames rather than attempting to overwrite a built-in. Predefined categories
 * are never captured for rollback and never deleted.
 *
 * NOTE the URL category id is a STRING (custom = "CUSTOM_xx"), so PUT/DELETE
 * target /urlCategories/{stringId} and the rollback entry ids are strings.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractUrlCategorySpecs(ctx.canvas).filter((s) => s.configuredName)
  const rollbackState: UrlCategoryRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listUrlCategories(client)
    const byName = new Map(
      existing.filter((c) => c.configuredName).map((c) => [c.configuredName as string, c]),
    )

    for (const spec of specs) {
      const live = byName.get(spec.configuredName)

      if (live && live.customCategory !== true) {
        throw new Error(
          `"${spec.configuredName}" is a predefined URL category and cannot be modified — rename your category to manage a custom one`,
        )
      }

      if (live && live.id != null) {
        rollbackState.push({
          configuredName: spec.configuredName,
          existed: true,
          id: live.id,
          prior: {
            configuredName: live.configuredName,
            superCategory: live.superCategory,
            type: live.type,
            urls: live.urls,
            keywords: live.keywords,
            description: live.description ?? '',
          },
        })
        const res = await client.zia('PUT', `/urlCategories/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update URL category "${spec.configuredName}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/urlCategories', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create URL category "${spec.configuredName}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveUrlCategory>(res.body)
        if (!created?.id) {
          throw new Error(`URL category "${spec.configuredName}" was created but the API returned no id`)
        }
        rollbackState.push({ configuredName: spec.configuredName, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.configuredName)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA URL category(ies) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedCategories: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA URL category(ies) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedCategories: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `URL category deployment failed after ${deployed.length} of ${specs.length} category(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedCategories: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA URL categories; throws on a non-OK response. */
export async function listUrlCategories(client: ZscalerClient): Promise<LiveUrlCategory[]> {
  const res = await client.ziaGetAll<LiveUrlCategory>('/urlCategories')
  if (!res.ok) {
    throw new Error(
      `Failed to list URL categories: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a custom URL category by configuredName; null when absent. */
export async function findUrlCategory(
  client: ZscalerClient,
  configuredName: string,
): Promise<LiveUrlCategory | null> {
  const all = await listUrlCategories(client)
  return all.find((c) => c.configuredName === configuredName) ?? null
}

function buildPayload(spec: UrlCategorySpec): Record<string, unknown> {
  // description always sent (even empty) so clearing it converges the live category.
  const body: Record<string, unknown> = {
    configuredName: spec.configuredName,
    superCategory: spec.superCategory || 'USER_DEFINED',
    type: spec.type,
    urls: spec.urls,
    description: spec.description ?? '',
    customCategory: true,
  }
  if (spec.keywords.length > 0) body.keywords = spec.keywords
  return body
}
