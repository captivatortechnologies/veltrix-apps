import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSentinelClient,
  armErrorMessage,
  parseJson,
  type SentinelClient,
  type SentinelResponse,
} from '../../lib/sentinel'
import {
  extractProductSettingSpecs,
  SENTINEL_SETTINGS_API_VERSION,
  type ProductSettingSpec,
} from './validate'

/**
 * State captured per setting so a rollback can restore the prior value. Product
 * settings are fixed-name singletons that are never created or deleted, so this
 * only ever holds the prior kind/properties (or records that the singleton had
 * not yet materialised, in which case rollback leaves it as-is — never deletes).
 */
export interface ProductSettingRollbackEntry {
  setting: string
  existed: boolean
  prior?: { kind?: string; properties?: unknown }
}

/**
 * The Microsoft.SecurityInsights/settings request body for a spec. The kind and
 * the settingsName both equal the setting name; only the properties differ:
 * Anomalies / EyesOn carry isEnabled, EntityAnalytics carries entityProviders,
 * Ueba carries dataSources. The etag is intentionally NOT sent — this is an
 * unconditional upsert (a stale etag would fail optimistic concurrency).
 */
export function buildSettingBody(spec: ProductSettingSpec): unknown {
  switch (spec.setting) {
    case 'Anomalies':
      return { kind: 'Anomalies', properties: { isEnabled: spec.isEnabled } }
    case 'EyesOn':
      return { kind: 'EyesOn', properties: { isEnabled: spec.isEnabled } }
    case 'EntityAnalytics':
      return { kind: 'EntityAnalytics', properties: { entityProviders: spec.entityProviders } }
    case 'Ueba':
      return { kind: 'Ueba', properties: { dataSources: spec.dataSources } }
    default:
      return { kind: spec.setting, properties: {} }
  }
}

/** GET one product setting singleton by its settingsName. */
export function getSetting(client: SentinelClient, setting: string): Promise<SentinelResponse> {
  return client.request('GET', client.sentinelPath(`/settings/${setting}`), {
    apiVersion: SENTINEL_SETTINGS_API_VERSION,
  })
}

/**
 * Deploy product settings via ARM. Each declared singleton is GET (to capture its
 * prior value for rollback) then PUT (upsert) — this config type is UPDATE-only:
 * the four settings always exist as singletons and are never created or deleted.
 * Settings not declared here are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, armHost } = built

  const specs = extractProductSettingSpecs(ctx.canvas).filter((s) => s.setting)
  const rollbackState: ProductSettingRollbackEntry[] = []
  const updated: string[] = []

  try {
    for (const spec of specs) {
      const path = client.sentinelPath(`/settings/${spec.setting}`)
      const current = await getSetting(client, spec.setting)
      if (current.status === 200) {
        const prior = parseJson<{ kind?: string; properties?: unknown }>(current.body)
        rollbackState.push({ setting: spec.setting, existed: true, prior: { kind: prior?.kind, properties: prior?.properties } })
      } else if (current.status === 404) {
        // The singleton has not materialised yet; there is no prior value to
        // restore. Rollback leaves it untouched (it never deletes a setting).
        rollbackState.push({ setting: spec.setting, existed: false })
      } else {
        throw new Error(`Failed to read product setting "${spec.setting}": ${armErrorMessage(current)}`)
      }

      const res = await client.request('PUT', path, { apiVersion: SENTINEL_SETTINGS_API_VERSION, body: buildSettingBody(spec) })
      if (!res.ok) throw new Error(`Failed to update product setting "${spec.setting}": ${armErrorMessage(res)}`)
      updated.push(spec.setting)
    }

    return {
      success: true,
      message: `Product settings deployed to ${armHost}: ${updated.length} updated`,
      artifacts: { armHost, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Product setting deployment failed after ${updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { armHost, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}
