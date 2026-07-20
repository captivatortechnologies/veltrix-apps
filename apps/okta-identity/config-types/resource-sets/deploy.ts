import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractResourceSetSpecs,
  type LiveResourceMembership,
  type LiveResourceSet,
} from './validate'

/** One page of resource sets is read with this cap — sets per org are few. */
export const RESOURCE_SET_LIST_LIMIT = 200
/** Page size when listing a set's resource memberships. */
export const RESOURCE_MEMBERSHIP_LIMIT = 100

export interface ResourceSetRollbackEntry {
  label: string
  existed: boolean
  /** The resource-set id Okta assigns — the rollback key (never the label). */
  id?: string
  /** Prior { label, description }, captured before an update. */
  prior?: { label: string; description: string }
  /** Prior resource references, captured before an update so rollback restores them. */
  priorResources?: string[]
}

/**
 * Deploy resource sets via the Okta Roles API. NO UPSERT exists, so for each
 * declared set:
 *   - GET  /iam/resource-sets            — list and match by label
 *   - PUT  /iam/resource-sets/{id}       — replace label/description (capture prior)
 *   - POST /iam/resource-sets            — create with the full resources list
 *
 * Okta only accepts the resources array at CREATE time. On UPDATE, PUT changes
 * only label/description, so the resource membership is reconciled via the
 * /resources sub-resource — additions with PATCH { additions: [...] }, removals
 * with DELETE .../resources/{membershipId}.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractResourceSetSpecs(ctx.canvas).filter(
    (s) => s.label && s.description && s.resources.length > 0,
  )
  const rollbackState: ResourceSetRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    // List every resource set once; match candidates in memory by label.
    const liveSets = await listResourceSets(client)

    for (const spec of specs) {
      const existing = findResourceSetByLabel(liveSets, spec.label)

      if (existing?.id) {
        // UPDATE — replace label/description, then reconcile resources via the
        // sub-resource. Capture the prior profile + resource set for rollback.
        const currentMemberships = await listResourceMemberships(client, existing.id)
        rollbackState.push({
          label: spec.label,
          existed: true,
          id: existing.id,
          prior: {
            label: existing.label ?? spec.label,
            description: typeof existing.description === 'string' ? existing.description : '',
          },
          priorResources: currentMemberships.map(membershipRef).filter((r): r is string => !!r),
        })

        const res = await client.request('PUT', `/iam/resource-sets/${existing.id}`, {
          body: { label: spec.label, description: spec.description },
        })
        if (!res.ok) {
          throw new Error(`Failed to update resource set "${spec.label}": ${oktaErrorMessage(res)}`)
        }
        await reconcileResources(client, existing.id, spec.resources, currentMemberships)
      } else {
        // CREATE — the resources array is accepted here (the only place it is).
        const res = await client.request('POST', '/iam/resource-sets', {
          body: { label: spec.label, description: spec.description, resources: spec.resources },
        })
        if (!res.ok) {
          throw new Error(`Failed to create resource set "${spec.label}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveResourceSet>(res.body)
        if (!created?.id) {
          throw new Error(`Resource set "${spec.label}" was created but the API returned no id`)
        }
        rollbackState.push({ label: spec.label, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} resource set(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedResourceSets: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Resource set deployment failed after ${deployed.length} of ${specs.length} set(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedResourceSets: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * List resource sets (one page, limit 200 — sets per org are few). The IAM
 * endpoint wraps the array under the hyphenated key `resource-sets`.
 */
export async function listResourceSets(client: OktaClient): Promise<LiveResourceSet[]> {
  const res = await client.request('GET', '/iam/resource-sets', { query: { limit: RESOURCE_SET_LIST_LIMIT } })
  if (!res.ok) {
    throw new Error(`Failed to list resource sets: ${oktaErrorMessage(res)}`)
  }
  return parseJson<{ 'resource-sets'?: LiveResourceSet[] }>(res.body)?.['resource-sets'] ?? []
}

/** Find a resource set by exact label; null when absent. */
export function findResourceSetByLabel(sets: LiveResourceSet[], label: string): LiveResourceSet | null {
  return sets.find((s) => s.label === label) ?? null
}

/** List a resource set's current resource memberships (one page, limit 100). */
export async function listResourceMemberships(
  client: OktaClient,
  setId: string,
): Promise<LiveResourceMembership[]> {
  const res = await client.request('GET', `/iam/resource-sets/${setId}/resources`, {
    query: { limit: RESOURCE_MEMBERSHIP_LIMIT },
  })
  if (!res.ok) {
    throw new Error(`Failed to list resources for resource set ${setId}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<{ resources?: LiveResourceMembership[] }>(res.body)?.resources ?? []
}

/**
 * The canonical reference string for a live membership — its ORN when present,
 * otherwise its REST URL (`_links.self.href`). Used to compare a live membership
 * against a desired ORN/URL reference.
 */
export function membershipRef(m: LiveResourceMembership): string | undefined {
  if (typeof m.orn === 'string' && m.orn) return m.orn
  const href = m._links?.self?.href
  return typeof href === 'string' && href ? href : undefined
}

/** True when a desired reference matches a live membership (ORN or URL form). */
export function membershipMatches(m: LiveResourceMembership, desired: string): boolean {
  if (typeof m.orn === 'string' && m.orn === desired) return true
  const href = m._links?.self?.href
  return typeof href === 'string' && href === desired
}

/**
 * Converge a resource set's membership to exactly `desired`:
 *   - add references not present via PATCH { additions: [...] } (one call)
 *   - remove memberships not desired via DELETE .../resources/{membershipId}
 * A 404 on a remove (already gone) is tolerated.
 */
export async function reconcileResources(
  client: OktaClient,
  setId: string,
  desired: string[],
  current: LiveResourceMembership[],
): Promise<void> {
  const additions = desired.filter((ref) => !current.some((m) => membershipMatches(m, ref)))
  if (additions.length > 0) {
    const res = await client.request('PATCH', `/iam/resource-sets/${setId}/resources`, {
      body: { additions },
    })
    if (!res.ok) {
      throw new Error(`Failed to add resources to resource set ${setId}: ${oktaErrorMessage(res)}`)
    }
  }

  for (const membership of current) {
    const stillDesired = desired.some((ref) => membershipMatches(membership, ref))
    if (!stillDesired && membership.id) {
      const ref = membershipRef(membership) ?? membership.id
      const res = await client.request('DELETE', `/iam/resource-sets/${setId}/resources/${membership.id}`)
      if (!res.ok && res.status !== 404) {
        throw new Error(
          `Failed to remove resource "${ref}" from resource set ${setId}: ${oktaErrorMessage(res)}`,
        )
      }
    }
  }
}
