import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { asArray, buildPPClient, ppErrorMessage, type PPClient } from '../../lib/proofpoint'
import { domainKey, extractDomainSpecs, type DomainSpec, type LiveDomain } from './validate'

export interface DomainRollbackEntry {
  key: string
  name: string
  existed: boolean
  prior?: LiveDomain
}

/**
 * Deploy Proofpoint Essentials domains via the Essentials Interface API
 * (/orgs/{org}/domains).
 *
 * Identity is the domain name. This is an UPSERT keyed on the name: list the org's
 * domains, then PUT an existing domain to the declared state or POST a new one.
 * Domains the deploy did not declare are never touched. The prior state of each
 * touched domain is captured so rollback can restore it (or delete a created one).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, orgDomain } = built

  const specs = extractDomainSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: DomainRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const existing = await listDomains(client)
    const byKey = new Map(existing.filter((d) => d.name).map((d) => [domainKey(d.name as string), d]))

    for (const spec of specs) {
      const key = domainKey(spec.name)
      const live = byKey.get(key)
      const body = buildBody(spec)

      if (live) {
        rollbackState.push({ key, name: spec.name, existed: true, prior: live })
        const res = await client.request('PUT', `${client.orgPath}/domains/${encodeURIComponent(spec.name)}`, { body })
        if (!res.ok) throw new Error(`Failed to update domain "${spec.name}": ${ppErrorMessage(res)}`)
      } else {
        rollbackState.push({ key, name: spec.name, existed: false })
        const res = await client.request('POST', `${client.orgPath}/domains`, { body })
        if (!res.ok) throw new Error(`Failed to create domain "${spec.name}": ${ppErrorMessage(res)}`)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} domain(s) to Proofpoint Essentials org "${orgDomain}": ${deployed.join(', ')}`,
      artifacts: { baseUrl, orgDomain, deployedDomains: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Domain deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, orgDomain, deployedDomains: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** List all domains in the configured org; throws on a non-OK response. */
export async function listDomains(client: PPClient): Promise<LiveDomain[]> {
  const res = await client.request('GET', `${client.orgPath}/domains`)
  if (!res.ok) throw new Error(`Failed to list domains: ${ppErrorMessage(res)}`)
  return asArray<LiveDomain>(res.body, 'domains')
}

/** Build the request body for a domain create/update. */
export function buildBody(spec: DomainSpec): Record<string, unknown> {
  return {
    name: spec.name,
    is_active: spec.isActive,
    is_relay: spec.isRelay,
    destination: spec.destination,
    failovers: spec.failovers,
  }
}
