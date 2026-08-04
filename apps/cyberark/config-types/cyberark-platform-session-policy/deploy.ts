import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { cyberArkErrorMessage, parseJson, buildCyberArkClient, type CyberArkClient } from '../../lib/cyberark'
import { extractSessionPolicySpecs, type LiveSessionPolicy, type SessionPolicySpec } from './validate'

/** Rollback state for one platform's policy — the full prior GET response body. */
export interface SessionPolicyRollbackEntry {
  platformId: string
  prior: LiveSessionPolicy
}

/**
 * Deploy CyberArk platform session-management policies via the PVWA Gen2
 * REST API — a GET/PUT SINGLETON per platform (no create/delete): every
 * declared platform's policy is read (captured for rollback) then replaced
 * with the desired PSM server + connector state.
 *
 * `psm_connectors` is included in the PUT body only when the user has
 * declared at least one entry — an empty map is omitted rather than sent as
 * `[]`, so a platform whose connectors this app doesn't yet manage keeps its
 * existing connector configuration instead of being silently wiped.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, pvwaUrl } = built

  const specs = extractSessionPolicySpecs(ctx.canvas).filter((s) => s.platformId && s.psmServerId)
  const rollbackState: SessionPolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const prior = await getSessionPolicy(client, spec.platformId)
      rollbackState.push({ platformId: spec.platformId, prior })

      const res = await client.request('PUT', `/Platforms/Targets/${encodeURIComponent(spec.platformId)}/PrivilegedSessionManagement/`, {
        body: buildPolicyBody(spec),
      })
      if (!res.ok) throw new Error(`Failed to update session policy for platform "${spec.platformId}": ${cyberArkErrorMessage(res)}`)
      deployed.push(spec.platformId)
    }

    await client.logoff()
    return {
      success: true,
      message: `Deployed ${deployed.length} platform session policy(ies) to ${pvwaUrl}: ${deployed.join(', ')}`,
      artifacts: { pvwaUrl, deployedPlatforms: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Session policy deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { pvwaUrl, deployedPlatforms: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** GET a platform's session policy; throws on a non-OK response (e.g. an unknown platform id). */
export async function getSessionPolicy(client: CyberArkClient, platformId: string): Promise<LiveSessionPolicy> {
  const res = await client.request('GET', `/Platforms/Targets/${encodeURIComponent(platformId)}/PrivilegedSessionManagement/`)
  if (!res.ok) throw new Error(`Failed to read session policy for platform "${platformId}": ${cyberArkErrorMessage(res)}`)
  return parseJson<LiveSessionPolicy>(res.body) ?? {}
}

/** Build the PUT body. PSMConnectors is included only when the spec declares at least one. */
export function buildPolicyBody(spec: SessionPolicySpec): Record<string, unknown> {
  const body: Record<string, unknown> = { PSMServerId: spec.psmServerId }
  if (spec.psmServerName) body.PSMServerName = spec.psmServerName
  const entries = Object.entries(spec.psmConnectors)
  if (entries.length > 0) {
    body.PSMConnectors = entries.map(([PSMConnectorID, Enabled]) => ({ PSMConnectorID, Enabled }))
  }
  return body
}
