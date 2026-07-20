import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import { extractThreatInsightSpecs, type LiveThreatInsight, type ThreatInsightSpec } from './validate'

export interface ThreatInsightRollbackData {
  /** The org's prior ThreatInsight config, replayed via POST on rollback. */
  prior?: { action: string; excludeZones: string[] }
}

/**
 * Deploy the org's ThreatInsight configuration. It is a SINGLETON, so there is no
 * list/match:
 *   - GET  /threats/configuration   — read the current config (captured for rollback)
 *   - POST /threats/configuration   — update it (a full replace)
 *
 * There is no create/delete and no lifecycle. The update is idempotent — the same
 * canvas re-applied is a no-op on Okta's side.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractThreatInsightSpecs(ctx.canvas).filter((s) => s.action)
  if (specs.length === 0) {
    return { success: false, message: 'No ThreatInsight configuration provided' }
  }
  const spec = specs[0]

  try {
    // Capture the current config so rollback can restore it.
    const current = await getThreatInsight(client)
    const rollbackData: ThreatInsightRollbackData = {
      prior: {
        action: typeof current?.action === 'string' ? current.action : 'audit',
        excludeZones: Array.isArray(current?.excludeZones) ? current!.excludeZones!.map(String) : [],
      },
    }

    const res = await client.request('POST', '/threats/configuration', { body: buildThreatInsightBody(spec) })
    if (!res.ok) {
      throw new Error(`Failed to update ThreatInsight configuration: ${oktaErrorMessage(res)}`)
    }

    return {
      success: true,
      message: `Updated ThreatInsight configuration on Okta org at ${baseUrl}: action=${spec.action}, ${spec.excludeZones.length} exempt zone(s)`,
      artifacts: { baseUrl, action: spec.action, excludeZones: spec.excludeZones },
      rollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `ThreatInsight deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { baseUrl },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Read the org's current ThreatInsight configuration. */
export async function getThreatInsight(client: OktaClient): Promise<LiveThreatInsight | null> {
  const res = await client.request('GET', '/threats/configuration')
  if (!res.ok) {
    throw new Error(`Failed to read ThreatInsight configuration: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveThreatInsight>(res.body)
}

/**
 * Build the update body — a full replace of action + excludeZones. excludeZones
 * is always sent (empty array clears exemptions) so the POST converges and drift
 * detection agrees about the target state.
 */
export function buildThreatInsightBody(spec: ThreatInsightSpec): Record<string, unknown> {
  return { action: spec.action, excludeZones: spec.excludeZones }
}
