import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage, cloudflareResult } from '../../lib/cloudflare'
import { attachDriftActor, veltrixActorLogins } from '../lib/cloudflareAudit'
import { extractBotManagementSpec, parseJsonObject, type LiveBotManagement } from './validate'

/** Normalize a live value to a comparable string, same treatment zone-settings gives its values. */
function normalize(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Detect drift between the deployed Bot Management configuration and the live
 * zone. Re-reads the singleton (GET /bot_management) and diffs every field the
 * canvas actually declares — the six "Shared Config" fields plus whatever keys
 * are present in advanced_json. Fields outside the declared set (including
 * read-only ones like stale_zone_configuration) are never compared, matching
 * the scope of what this app manages.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const spec = extractBotManagementSpec(ctx.deployedConfig)
  if (!spec) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const res = await client.zone('GET', '/bot_management')
    if (!res.ok) {
      return {
        hasDrift: true,
        diffs: [
          {
            field: 'bot_management',
            expected: 'reachable',
            actual: `unreadable: ${cloudflareErrorMessage(res)}`,
            severity: 'warning',
          },
        ],
      }
    }
    const live = cloudflareResult<LiveBotManagement>(res) ?? {}

    const declared: Record<string, unknown> = {
      ai_bots_protection: spec.aiBotsProtection,
      crawler_protection: spec.crawlerProtection,
      content_bots_protection: spec.contentBotsProtection,
      cf_robots_variant: spec.cfRobotsVariant,
      enable_js: spec.enableJs,
      using_latest_model: spec.usingLatestModel,
      ...(parseJsonObject(spec.advancedJson).value ?? {}),
    }

    for (const [key, expected] of Object.entries(declared)) {
      const actual = live[key]
      if (normalize(actual) !== normalize(expected)) {
        diffs.push({
          field: `bot_management.${key}`,
          expected: normalize(expected) || '(empty)',
          actual: normalize(actual) || 'not set',
          severity: 'warning',
        })
      }
    }

    await attachDriftActor(client, diffs, { targetName: 'bot_management', excludeActorLogins })
  } catch (error) {
    diffs.push({
      field: 'cloudflare',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
