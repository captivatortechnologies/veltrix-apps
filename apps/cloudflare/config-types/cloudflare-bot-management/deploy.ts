import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage, cloudflareResult } from '../../lib/cloudflare'
import { extractBotManagementSpec, parseJsonObject, type BotManagementSpec, type LiveBotManagement } from './validate'

/** Read-only keys Cloudflare reports but never accepts on write. */
const READ_ONLY_KEYS = new Set(['stale_zone_configuration'])

export interface BotManagementRollbackEntry {
  /** The full prior live object, captured before the update so it can be restored verbatim. */
  prior: LiveBotManagement
}

/**
 * Deploy the zone's Bot Management configuration (zone-scoped singleton).
 *
 * There is no create/delete — only GET then PUT. Cloudflare's PUT is a
 * declarative snapshot of the fields you send rather than a sparse patch, so
 * this reads the CURRENT live object first (captured for rollback), merges the
 * declared fields on top of it, strips read-only keys, and PUTs the merged
 * object. That preserves any field this app does not manage (or that the
 * user's plan doesn't expose here) instead of silently resetting it.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const spec = extractBotManagementSpec(ctx.canvas)
  if (!spec) {
    return { success: true, message: 'No Bot Management configuration declared — nothing to deploy', artifacts: { domain } }
  }

  try {
    const current = await client.zone('GET', '/bot_management')
    if (!current.ok) {
      throw new Error(`Failed to read current Bot Management settings: ${cloudflareErrorMessage(current)}`)
    }
    const prior = cloudflareResult<LiveBotManagement>(current) ?? {}

    const merged = buildMergedPayload(prior, spec)
    const res = await client.zone('PUT', '/bot_management', { body: merged })
    if (!res.ok) throw new Error(`Failed to update Bot Management settings: ${cloudflareErrorMessage(res)}`)

    return {
      success: true,
      message: `Deployed Bot Management settings for zone "${domain}"`,
      artifacts: { domain },
      rollbackData: { prior },
    }
  } catch (error) {
    return {
      success: false,
      message: `Bot Management deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { domain },
    }
  }
}

/** Merge the declared fields onto the current live object, stripping read-only keys. */
export function buildMergedPayload(prior: LiveBotManagement, spec: BotManagementSpec): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...prior }
  for (const key of READ_ONLY_KEYS) delete merged[key]

  merged.ai_bots_protection = spec.aiBotsProtection
  merged.crawler_protection = spec.crawlerProtection
  merged.content_bots_protection = spec.contentBotsProtection
  merged.cf_robots_variant = spec.cfRobotsVariant
  merged.enable_js = spec.enableJs
  merged.using_latest_model = spec.usingLatestModel

  const advanced = parseJsonObject(spec.advancedJson).value ?? {}
  for (const [key, value] of Object.entries(advanced)) {
    if (!READ_ONLY_KEYS.has(key)) merged[key] = value
  }

  return merged
}
