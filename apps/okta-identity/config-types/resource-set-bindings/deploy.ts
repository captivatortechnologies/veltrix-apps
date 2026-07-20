import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import { extractBindingSpecs, type LiveBinding, type LiveBindingMember } from './validate'

/** Page size when listing a binding's members. */
export const BINDING_MEMBER_LIMIT = 200

export interface BindingRollbackEntry {
  /** Resource set id/label — needed to build the binding's REST path. */
  resourceSet: string
  /** Role id/type — the other half of the path and the binding's identity. */
  role: string
  /** True when the binding already existed before this deploy touched it. */
  existed: boolean
  /**
   * Prior member references (principal URLs/ORNs) captured before an update, so
   * rollback can reconcile the membership back to exactly what it was. Only set
   * when `existed` is true.
   */
  priorMembers?: string[]
}

// --- Path builders ------------------------------------------------------------
// resourceSet / role come from user input and may be labels (with spaces), so
// every dynamic path segment is URL-encoded.

/** `/iam/resource-sets/{rs}/bindings` — the collection (list + create). */
export function bindingsPath(resourceSet: string): string {
  return `/iam/resource-sets/${encodeURIComponent(resourceSet)}/bindings`
}

/** `/iam/resource-sets/{rs}/bindings/{role}` — one binding (get + delete). */
export function bindingPath(resourceSet: string, role: string): string {
  return `${bindingsPath(resourceSet)}/${encodeURIComponent(role)}`
}

/** `/iam/resource-sets/{rs}/bindings/{role}/members` — the members sub-resource. */
export function bindingMembersPath(resourceSet: string, role: string): string {
  return `${bindingPath(resourceSet, role)}/members`
}

/**
 * Deploy resource-set bindings via the Okta Roles API. A binding is keyed by the
 * (resourceSet, role) PAIR and there is NO upsert, so for each declared binding:
 *   - GET   .../bindings/{role}          — capture pre-existence + prior members
 *   - POST  .../bindings                 — create with { role, members } (create-only)
 *   - members on an EXISTING binding are reconciled ONE AT A TIME via the members
 *     sub-resource — additions with PATCH { additions: [...] } (one call), removals
 *     with DELETE .../members/{membershipId} — mirroring how `resource-sets`
 *     reconciles its resources.
 *
 * Okta only accepts the members array at CREATE time, and it deletes the binding
 * when the LAST member is removed — so reconciliation ADDS before it REMOVES, and
 * validate guarantees at least one desired member. On rollback a CREATED binding is
 * deleted; an UPDATED binding's membership is reconciled back to the captured prior.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractBindingSpecs(ctx.canvas).filter((s) => s.resourceSet && s.role && s.members.length > 0)
  const rollbackState: BindingRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = `${spec.resourceSet}:${spec.role}`

      // GET first so rollback knows whether we CREATED this binding (delete on
      // rollback) or UPDATED an existing one (restore its prior members).
      const existing = await getBinding(client, spec.resourceSet, spec.role)

      if (existing) {
        // UPDATE — reconcile members via the sub-resource. Capture prior members.
        const currentMembers = await listBindingMembers(client, spec.resourceSet, spec.role)
        rollbackState.push({
          resourceSet: spec.resourceSet,
          role: spec.role,
          existed: true,
          priorMembers: currentMembers.map(bindingMemberRef).filter((r): r is string => !!r),
        })
        await reconcileBindingMembers(client, spec.resourceSet, spec.role, spec.members, currentMembers)
      } else {
        // CREATE — the members array is accepted here (the only place it is).
        const res = await client.request('POST', bindingsPath(spec.resourceSet), {
          body: { role: spec.role, members: spec.members },
        })
        if (!res.ok) {
          throw new Error(`Failed to create binding "${label}": ${oktaErrorMessage(res)}`)
        }
        rollbackState.push({ resourceSet: spec.resourceSet, role: spec.role, existed: false })
        createdIds.push(label)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} resource-set binding(s) to Okta org at ${baseUrl}: ${
        deployed.join(', ') || 'none'
      }.`,
      artifacts: { baseUrl, deployedBindings: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Resource-set binding deployment failed after ${deployed.length} of ${specs.length} binding(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedBindings: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * Fetch a single binding by (resourceSet, role); null on 404 (no such binding).
 * The path fully identifies it — no list/match needed.
 */
export async function getBinding(
  client: OktaClient,
  resourceSet: string,
  role: string,
): Promise<LiveBinding | null> {
  const res = await client.request('GET', bindingPath(resourceSet, role))
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(
      `Failed to fetch binding of role "${role}" in resource set "${resourceSet}": ${oktaErrorMessage(res)}`,
    )
  }
  return parseJson<LiveBinding>(res.body)
}

/** List a binding's current members (one page, limit 200). */
export async function listBindingMembers(
  client: OktaClient,
  resourceSet: string,
  role: string,
): Promise<LiveBindingMember[]> {
  const res = await client.request('GET', bindingMembersPath(resourceSet, role), {
    query: { limit: BINDING_MEMBER_LIMIT },
  })
  if (!res.ok) {
    throw new Error(
      `Failed to list members for binding "${resourceSet}:${role}": ${oktaErrorMessage(res)}`,
    )
  }
  return parseJson<{ members?: LiveBindingMember[] }>(res.body)?.members ?? []
}

/**
 * The canonical reference string for a live member — its ORN when present,
 * otherwise the principal REST URL (`_links.self.href`). Used to compare a live
 * member against a desired member reference.
 */
export function bindingMemberRef(m: LiveBindingMember): string | undefined {
  if (typeof m.orn === 'string' && m.orn) return m.orn
  const href = m._links?.self?.href
  return typeof href === 'string' && href ? href : undefined
}

/** True when a desired reference matches a live member (ORN or principal-URL form). */
export function bindingMemberMatches(m: LiveBindingMember, desired: string): boolean {
  if (typeof m.orn === 'string' && m.orn === desired) return true
  const href = m._links?.self?.href
  return typeof href === 'string' && href === desired
}

/**
 * Converge a binding's membership to exactly `desired`:
 *   - ADD references not present via PATCH { additions: [...] } (one call)
 *   - REMOVE members not desired via DELETE .../members/{membershipId}
 * Additions run BEFORE removals so the member count never transiently hits zero
 * (Okta deletes the binding when its last member is removed). A 404 on a remove
 * (already gone) is tolerated.
 */
export async function reconcileBindingMembers(
  client: OktaClient,
  resourceSet: string,
  role: string,
  desired: string[],
  current: LiveBindingMember[],
): Promise<void> {
  const additions = desired.filter((ref) => !current.some((m) => bindingMemberMatches(m, ref)))
  if (additions.length > 0) {
    const res = await client.request('PATCH', bindingMembersPath(resourceSet, role), {
      body: { additions },
    })
    if (!res.ok) {
      throw new Error(
        `Failed to add members to binding "${resourceSet}:${role}": ${oktaErrorMessage(res)}`,
      )
    }
  }

  for (const member of current) {
    const stillDesired = desired.some((ref) => bindingMemberMatches(member, ref))
    if (!stillDesired && member.id) {
      const ref = bindingMemberRef(member) ?? member.id
      const res = await client.request(
        'DELETE',
        `${bindingMembersPath(resourceSet, role)}/${encodeURIComponent(member.id)}`,
      )
      if (!res.ok && res.status !== 404) {
        throw new Error(
          `Failed to remove member "${ref}" from binding "${resourceSet}:${role}": ${oktaErrorMessage(res)}`,
        )
      }
    }
  }
}
