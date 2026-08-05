import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, parseJson, teleportErrorMessage, type TeleportClient } from '../../lib/teleport'
import { extractDiscoveryConfigSpecs, parseMatcherJson, type DiscoveryConfigSpec } from './validate'

export interface DiscoveryConfigRollbackEntry {
  name: string
  existed: boolean
  priorDiscoveryGroup?: string
  priorAws?: unknown[]
  priorAzureMatchers?: unknown[]
  priorGcpMatchers?: unknown[]
  priorKube?: unknown[]
}

interface LiveDiscoveryConfig {
  discoveryGroup?: string
  aws?: unknown[]
  azureMatchers?: unknown[]
  gcpMatchers?: unknown[]
  kube?: unknown[]
}

/** GET a DiscoveryConfig by name; null on 404 (absent). Shared by deploy, healthCheck and driftDetect. */
export async function getDiscoveryConfig(client: TeleportClient, name: string): Promise<LiveDiscoveryConfig | null> {
  const site = await client.resolveSite()
  const res = await client.request(
    'GET',
    `/v1/webapi/sites/${encodeURIComponent(site)}/discoveryconfig/${encodeURIComponent(name)}`,
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to read discovery config "${name}": ${teleportErrorMessage(res)}`)
  return parseJson<LiveDiscoveryConfig>(res.body)
}

/**
 * Build the matcher payload for a spec. Each matcher JSON textarea was
 * already validated as valid JSON array syntax — parseMatcherJson never
 * throws for input that passed validate.ts.
 */
function matcherPayload(spec: DiscoveryConfigSpec) {
  const aws = parseMatcherJson(spec.awsMatchersJson)
  const azure = parseMatcherJson(spec.azureMatchersJson)
  const gcp = parseMatcherJson(spec.gcpMatchersJson)
  const kube = parseMatcherJson(spec.kubeMatchersJson)
  return {
    aws: aws.ok ? aws.value : [],
    azureMatchers: azure.ok ? azure.value : [],
    gcpMatchers: gcp.ok ? gcp.value : [],
    kube: kube.ok ? kube.value : [],
  }
}

/**
 * Deploy DiscoveryConfigs via the Teleport Proxy web API
 * (lib/web/discoveryconfig.go). Wire keys are `aws` / `azureMatchers` /
 * `gcpMatchers` / `kube` (lib/web/ui/discoveryconfig.go's `DiscoveryConfig`
 * struct tags — Azure/GCP are NOT symmetric with their canvas field names):
 *   - POST /v1/webapi/sites/{site}/discoveryconfig          — create
 *   - PUT  /v1/webapi/sites/{site}/discoveryconfig/{name}    — update
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractDiscoveryConfigSpecs(ctx.canvas).filter((s) => s.name && s.discoveryGroup)
  const rollbackState: DiscoveryConfigRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const site = await client.resolveSite()

    for (const spec of specs) {
      const existing = await getDiscoveryConfig(client, spec.name)
      const matchers = matcherPayload(spec)

      if (existing) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          priorDiscoveryGroup: existing.discoveryGroup,
          priorAws: existing.aws,
          priorAzureMatchers: existing.azureMatchers,
          priorGcpMatchers: existing.gcpMatchers,
          priorKube: existing.kube,
        })
        const res = await client.request(
          'PUT',
          `/v1/webapi/sites/${encodeURIComponent(site)}/discoveryconfig/${encodeURIComponent(spec.name)}`,
          { body: { discoveryGroup: spec.discoveryGroup, ...matchers } },
        )
        if (!res.ok) throw new Error(`Failed to update discovery config "${spec.name}": ${teleportErrorMessage(res)}`)
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.request('POST', `/v1/webapi/sites/${encodeURIComponent(site)}/discoveryconfig`, {
          body: { name: spec.name, discoveryGroup: spec.discoveryGroup, ...matchers },
        })
        if (!res.ok) throw new Error(`Failed to create discovery config "${spec.name}": ${teleportErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} discovery config(s) to Teleport at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedConfigs: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Discovery config deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedConfigs: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

export type { DiscoveryConfigSpec }
