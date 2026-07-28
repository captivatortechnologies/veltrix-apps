import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSentinelClient,
  armErrorMessage,
  parseJson,
  SENTINEL_API_VERSION,
  type SentinelClient,
} from '../../lib/sentinel'
import { extractIndicatorSpecs, indicatorKey, MANAGED_SOURCE, type IndicatorSpec } from './validate'
import { queryManagedIndicators, type LiveIndicator } from './healthCheck'

/**
 * State captured per indicator so a rollback can delete creates and restore
 * updates. Creation is a POST that returns a server-assigned GUID `name`; that
 * name is captured here so a rollback can address the exact resource.
 */
export interface IndicatorRollbackEntry {
  displayName: string
  existed: boolean
  /** The ARM resource name (server GUID). Empty only if a create's response name could not be read. */
  name: string
  /** Prior properties (of an updated indicator) so a rollback can restore them. */
  prior?: { properties?: Record<string, unknown> }
}

/** The child path for an indicator addressed by its ARM name (GET/PUT/DELETE). */
export function indicatorPath(client: SentinelClient, name: string): string {
  return client.sentinelPath(`/threatIntelligence/main/indicators/${name}`)
}

/** The action path for creating an indicator (POST — the server assigns the name). */
export function createIndicatorPath(client: SentinelClient): string {
  return client.sentinelPath('/threatIntelligence/main/createIndicator')
}

/**
 * The Microsoft.SecurityInsights threat-intelligence indicator request body for a
 * spec (kind: "indicator"). `source` is pinned to the managed source so every
 * write stays scoped to Veltrix-owned indicators. `validFrom` falls back to the
 * prior value (on update) or now (on create) so ARM always receives a valid-from;
 * `validUntil`/`description` are omitted when blank.
 */
export function buildIndicatorBody(spec: IndicatorSpec, opts?: { validFromFallback?: string }): unknown {
  const properties: Record<string, unknown> = {
    source: MANAGED_SOURCE,
    displayName: spec.displayName,
    pattern: spec.pattern,
    patternType: spec.stixType,
    confidence: spec.confidence,
    threatTypes: spec.threatTypes,
    threatIntelligenceTags: spec.tags,
    revoked: spec.revoked,
    validFrom: spec.validFrom || opts?.validFromFallback || new Date().toISOString(),
  }
  if (spec.description) properties.description = spec.description
  if (spec.validUntil) properties.validUntil = spec.validUntil
  return { kind: 'indicator', properties }
}

/**
 * Deploy threat intelligence indicators via ARM. Because creation is a POST that
 * returns a server-assigned GUID name, reconciliation is by display name among
 * indicators of the managed source: the managed indicators are queried once, then
 * each declared indicator is matched by display name. A match is updated in place
 * (PUT by its ARM name); a new indicator is created (POST createIndicator) and the
 * returned name captured for rollback. Indicators of other sources are untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, armHost } = built

  const specs = extractIndicatorSpecs(ctx.canvas).filter((s) => s.displayName)
  const rollbackState: IndicatorRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const managed = await queryManagedIndicators(client)
    const byKey = new Map<string, LiveIndicator>()
    for (const ind of managed) {
      const dn = typeof ind.properties?.displayName === 'string' ? ind.properties.displayName : ''
      if (dn) byKey.set(indicatorKey(dn), ind)
    }

    for (const spec of specs) {
      const matched = byKey.get(indicatorKey(spec.displayName))

      if (matched?.name) {
        // Update in place — capture prior state BEFORE the PUT so a mid-run
        // failure can still be rolled back.
        const priorProps = matched.properties ?? {}
        rollbackState.push({ displayName: spec.displayName, existed: true, name: matched.name, prior: { properties: priorProps } })
        const body = buildIndicatorBody(spec, { validFromFallback: typeof priorProps.validFrom === 'string' ? priorProps.validFrom : undefined })
        const res = await client.request('PUT', indicatorPath(client, matched.name), { apiVersion: SENTINEL_API_VERSION, body })
        if (!res.ok) throw new Error(`Failed to update indicator "${spec.displayName}": ${armErrorMessage(res)}`)
        updated.push(spec.displayName)
      } else {
        // Create via POST — the server assigns the name, captured from the response.
        const res = await client.request('POST', createIndicatorPath(client), { apiVersion: SENTINEL_API_VERSION, body: buildIndicatorBody(spec) })
        if (!res.ok) throw new Error(`Failed to create indicator "${spec.displayName}": ${armErrorMessage(res)}`)
        const name = parseJson<{ name?: string }>(res.body)?.name ?? ''
        rollbackState.push({ displayName: spec.displayName, existed: false, name })
        created.push(spec.displayName)
      }
    }

    return {
      success: true,
      message: `Threat intelligence indicators deployed to ${armHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { armHost, source: MANAGED_SOURCE, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Indicator deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { armHost, source: MANAGED_SOURCE, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}
