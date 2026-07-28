import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSentinelClient,
  armErrorMessage,
  parseJson,
  SENTINEL_API_VERSION,
  type SentinelClient,
  type SentinelResponse,
} from '../../lib/sentinel'
import { extractAnomalySpecs, type AnomalySettingSpec } from './validate'

/** State captured per setting so a rollback can delete creates and restore updates. */
export interface AnomalyRollbackEntry {
  name: string
  settingsResourceName: string
  existed: boolean
  prior?: { kind?: string; properties?: unknown }
}

/**
 * The Microsoft.SecurityInsights AnomalySecurityMLAnalyticsSettings request body
 * for a spec. displayName, enabled, anomalyVersion, frequency, isDefaultSettings
 * and settingsStatus are REQUIRED by ARM; the rest are included only when set.
 */
export function buildAnomalyBody(spec: AnomalySettingSpec): unknown {
  const properties: Record<string, unknown> = {
    displayName: spec.name,
    enabled: spec.enabled,
    anomalyVersion: spec.anomalyVersion,
    frequency: spec.frequency,
    settingsStatus: spec.settingsStatus,
    isDefaultSettings: spec.isDefaultSettings,
  }
  if (spec.description) properties.description = spec.description
  if (spec.settingsDefinitionId) properties.settingsDefinitionId = spec.settingsDefinitionId
  if (spec.tactics.length > 0) properties.tactics = spec.tactics
  if (spec.techniques.length > 0) properties.techniques = spec.techniques
  if (spec.customizableObservations) properties.customizableObservations = spec.customizableObservations
  return { kind: 'Anomaly', properties }
}

/** The ARM child-resource path for one anomaly setting by its resource name. */
export function anomalyPath(client: SentinelClient, settingsResourceName: string): string {
  return client.sentinelPath(`/securityMLAnalyticsSettings/${settingsResourceName}`)
}

/** GET one anomaly setting by its ARM resource name. */
export function getAnomalySetting(client: SentinelClient, settingsResourceName: string): Promise<SentinelResponse> {
  return client.request('GET', anomalyPath(client, settingsResourceName), { apiVersion: SENTINEL_API_VERSION })
}

/**
 * Deploy anomaly (ML) analytics settings via ARM. Reconciliation is by the
 * setting's deterministic securityMLAnalyticsSettings resource name (slug of the
 * name): GET the setting to learn whether it exists (and capture prior state for
 * rollback), then PUT (upsert) at the GA api-version. Settings not declared here
 * are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, armHost } = built

  const specs = extractAnomalySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: AnomalyRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    for (const spec of specs) {
      const current = await getAnomalySetting(client, spec.settingsResourceName)
      let existed = false
      if (current.status === 200) {
        existed = true
        const prior = parseJson<{ kind?: string; properties?: unknown }>(current.body)
        rollbackState.push({
          name: spec.name,
          settingsResourceName: spec.settingsResourceName,
          existed: true,
          prior: { kind: prior?.kind, properties: prior?.properties },
        })
      } else if (current.status === 404) {
        rollbackState.push({ name: spec.name, settingsResourceName: spec.settingsResourceName, existed: false })
      } else {
        throw new Error(`Failed to read anomaly setting "${spec.name}": ${armErrorMessage(current)}`)
      }

      const res = await client.request('PUT', anomalyPath(client, spec.settingsResourceName), {
        apiVersion: SENTINEL_API_VERSION,
        body: buildAnomalyBody(spec),
      })
      if (!res.ok) throw new Error(`Failed to ${existed ? 'update' : 'create'} anomaly setting "${spec.name}": ${armErrorMessage(res)}`)
      ;(existed ? updated : created).push(spec.name)
    }

    return {
      success: true,
      message: `Anomaly settings deployed to ${armHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Anomaly setting deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}
