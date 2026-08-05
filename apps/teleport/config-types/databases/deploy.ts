import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, parseJson, teleportErrorMessage, type TeleportClient } from '../../lib/teleport'
import { extractDatabaseSpecs, type DatabaseSpec, type Label } from './validate'

export interface DatabaseRollbackEntry {
  name: string
  existed: boolean
  /**
   * Prior protocol/uri/labels, captured from a live read (lib/web/ui/server.go's
   * `MakeDatabase` — verified `protocol`/`uri`/`labels` JSON fields). AWS RDS
   * metadata and the CA certificate are write-only from this API's
   * perspective (Teleport does not echo them back in a format this app can
   * reliably read) and are NOT captured/restored — see README.md's Coverage notes.
   */
  priorProtocol?: string
  priorUri?: string
  priorLabels?: Label[]
}

interface LiveDatabase {
  protocol?: string
  uri?: string
  labels?: Label[]
  aws?: unknown
}

/** GET a database by name; null on 404 (absent). Shared by deploy, healthCheck and driftDetect. */
export async function getDatabase(client: TeleportClient, name: string): Promise<LiveDatabase | null> {
  const site = await client.resolveSite()
  const res = await client.request('GET', `/v1/webapi/sites/${encodeURIComponent(site)}/databases/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to read database "${name}": ${teleportErrorMessage(res)}`)
  return parseJson<LiveDatabase>(res.body)
}

function createOrOverwriteBody(spec: DatabaseSpec, overwrite: boolean) {
  return {
    name: spec.name,
    protocol: spec.protocol,
    uri: spec.uri,
    labels: spec.labels,
    awsRds: spec.awsRds
      ? { accountId: spec.awsRds.accountId, resourceId: spec.awsRds.resourceId, vpcId: spec.awsRds.vpcId, subnets: spec.awsRds.subnets }
      : undefined,
    overwrite,
  }
}

/**
 * Deploy database resources via the Teleport Proxy web API (lib/web/databases.go):
 *   - POST /v1/webapi/sites/{site}/databases          — create (overwrite:false)
 *     or full replace, incl. protocol changes (overwrite:true) when it already exists
 *   - PUT  /v1/webapi/sites/{site}/databases/{name}    — applies caCert, which
 *     the create/overwrite endpoint does not accept
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractDatabaseSpecs(ctx.canvas).filter((s) => s.name && s.protocol && s.uri)
  const rollbackState: DatabaseRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const site = await client.resolveSite()

    for (const spec of specs) {
      const existing = await getDatabase(client, spec.name)

      if (existing) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          priorProtocol: existing.protocol,
          priorUri: existing.uri,
          priorLabels: existing.labels,
        })
      } else {
        rollbackState.push({ name: spec.name, existed: false })
      }

      const res = await client.request('POST', `/v1/webapi/sites/${encodeURIComponent(site)}/databases`, {
        body: createOrOverwriteBody(spec, !!existing),
      })
      if (!res.ok) {
        throw new Error(`Failed to ${existing ? 'update' : 'create'} database "${spec.name}": ${teleportErrorMessage(res)}`)
      }

      if (spec.caCert) {
        const putRes = await client.request(
          'PUT',
          `/v1/webapi/sites/${encodeURIComponent(site)}/databases/${encodeURIComponent(spec.name)}`,
          { body: { caCert: spec.caCert } },
        )
        if (!putRes.ok) {
          throw new Error(`Failed to apply CA certificate to database "${spec.name}": ${teleportErrorMessage(putRes)}`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} database(s) to Teleport at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedDatabases: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Database deployment failed after ${deployed.length} of ${specs.length} database(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedDatabases: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

export type { DatabaseSpec }
