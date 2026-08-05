import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, parseJson, teleportErrorMessage, type TeleportClient } from '../../lib/teleport'
import { extractGithubConnectorSpecs, buildGithubConnectorYaml, type GithubConnectorSpec } from './validate'

export interface GithubConnectorRollbackEntry {
  name: string
  existed: boolean
  /** The prior full resource YAML (including client_secret), captured for connectors this deploy UPDATED. */
  priorContent?: string
}

interface ConnectorResourceItem {
  content?: string
}

/**
 * Read a single GitHub connector by name; null on 404 (absent). NOTE: Teleport
 * includes client_secret in this single-connector response (unlike the list
 * endpoint) — see lib/teleport.ts's module comment on why this is transiently
 * unavoidable for real drift detection. Shared by deploy, healthCheck and driftDetect.
 */
export async function getGithubConnector(client: TeleportClient, name: string): Promise<ConnectorResourceItem | null> {
  const res = await client.request('GET', `/v1/webapi/github/connector/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read GitHub connector "${name}": ${teleportErrorMessage(res)}`)
  }
  return parseJson<ConnectorResourceItem>(res.body)
}

/**
 * Deploy GitHub SSO connectors via the Teleport Proxy web API
 * (lib/web/resources.go):
 *   - POST /v1/webapi/github          — create
 *   - PUT  /v1/webapi/github/{name}   — update an existing connector
 * Both send `{"content": "<full connector YAML>"}`. Identity is the NAME.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractGithubConnectorSpecs(ctx.canvas).filter((s) => s.name && s.spec)
  const rollbackState: GithubConnectorRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getGithubConnector(client, spec.name)
      const content = buildGithubConnectorYaml(spec)

      if (existing) {
        rollbackState.push({ name: spec.name, existed: true, priorContent: existing.content ?? '' })
        const res = await client.request('PUT', `/v1/webapi/github/${encodeURIComponent(spec.name)}`, {
          body: { content },
        })
        if (!res.ok) throw new Error(`Failed to update connector "${spec.name}": ${teleportErrorMessage(res)}`)
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.request('POST', '/v1/webapi/github', { body: { content } })
        if (!res.ok) throw new Error(`Failed to create connector "${spec.name}": ${teleportErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} GitHub connector(s) to Teleport at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedConnectors: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `GitHub connector deployment failed after ${deployed.length} of ${specs.length} connector(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedConnectors: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

export type { GithubConnectorSpec }
