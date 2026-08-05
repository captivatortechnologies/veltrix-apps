import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, parseJson, teleportErrorMessage, type TeleportClient } from '../../lib/teleport'
import { extractTrustedClusterSpecs, buildTrustedClusterYaml, type TrustedClusterSpec } from './validate'

export interface TrustedClusterRollbackEntry {
  name: string
  existed: boolean
  priorContent?: string
}

interface TrustedClusterResourceItem {
  content?: string
}

/** Read a single trusted cluster by name; null on 404 (absent). Shared by deploy, healthCheck and driftDetect. */
export async function getTrustedCluster(
  client: TeleportClient,
  name: string,
): Promise<TrustedClusterResourceItem | null> {
  // The web API has no single-item GET by name for trusted clusters — list and
  // find, matching lib/web/resources.go's getTrustedClustersHandle (there is
  // no `/v1/webapi/trustedcluster/{name}` GET route, only PUT/DELETE by name).
  const res = await client.request('GET', '/v1/webapi/trustedcluster')
  if (!res.ok) {
    throw new Error(`Failed to list trusted clusters: ${teleportErrorMessage(res)}`)
  }
  const items = parseJson<Array<{ name?: string; content?: string }>>(res.body) ?? []
  const match = items.find((item) => item.name === name)
  return match ? { content: match.content } : null
}

/**
 * Deploy trusted clusters via the Teleport Proxy web API
 * (lib/web/resources.go's upsertTrustedCluster):
 *   - POST /v1/webapi/trustedcluster        — create
 *   - PUT  /v1/webapi/trustedcluster/{name} — update an existing trusted cluster
 * Both send `{"content": "<full trusted_cluster YAML>"}`. Identity is the NAME.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractTrustedClusterSpecs(ctx.canvas).filter((s) => s.name && s.spec)
  const rollbackState: TrustedClusterRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getTrustedCluster(client, spec.name)
      const content = buildTrustedClusterYaml(spec)

      if (existing) {
        rollbackState.push({ name: spec.name, existed: true, priorContent: existing.content ?? '' })
        const res = await client.request('PUT', `/v1/webapi/trustedcluster/${encodeURIComponent(spec.name)}`, {
          body: { content },
        })
        if (!res.ok) throw new Error(`Failed to update trusted cluster "${spec.name}": ${teleportErrorMessage(res)}`)
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.request('POST', '/v1/webapi/trustedcluster', { body: { content } })
        if (!res.ok) throw new Error(`Failed to create trusted cluster "${spec.name}": ${teleportErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} trusted cluster(s) to Teleport at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedClusters: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Trusted cluster deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedClusters: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

export type { TrustedClusterSpec }
