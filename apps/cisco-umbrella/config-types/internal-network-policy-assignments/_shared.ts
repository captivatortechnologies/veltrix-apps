// Shared helpers for the Cisco Umbrella Internal Network Policy Assignments
// config type (validate + deploy + rollback + drift).
//
// Umbrella's DNS/Web POLICIES themselves are READ-ONLY through the public API
// (GET /deployments/v2/policies?type=dns|web only — no create/update/delete of
// the policy object or its ruleset was found anywhere: not in Cisco's official
// external Postman collection, not in the community `josgabfer/UmbrellaAPI`
// project, not in Cisco's Refit-based client). Policy composition (content
// filtering, security settings, block pages, rule ordering) remains
// dashboard-only.
//
// The one CONFIRMED write capability on a policy is membership: which
// identities (Networks, Internal Networks, Roaming Computers, ...) it applies
// to, via `PUT`/`DELETE /deployments/v2/policies/{policyId}/identities/{originId}`
// (no body). Confirmed via TWO independent sources: Cisco's own Refit client
// (github.com/panoramicdata/Cisco.Api, IUmbrella.AddIdentityToPolicyAsync /
// DeleteIdentityFromPolicyAsync) and Microsoft's official Azure Sentinel
// "CiscoUmbrella-AssignPolicyToIdentity" playbook, which calls this exact path
// against api.umbrella.com.
//
// This config type scopes that membership write to the ONE identity type this
// app also manages end-to-end: Internal Network Subnets
// (config-types/internal-network-subnets, /deployments/v2/internalnetworks) —
// the only identity kind with a CONFIRMED read-back endpoint too
// (`GET /deployments/v2/internalnetworks/{originId}/policies`,
// IUmbrella.ListPoliciesForInternalNetworkAsync), which lets drift detection
// verify an assignment rather than only ever asserting it blindly. Extending
// this to Networks/Roaming Computers is deferred until their own
// policies-listing endpoint is independently confirmed.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import {
  DEPLOYMENTS_INTERNAL_NETWORK_SUBNETS_PATH,
  DEPLOYMENTS_POLICIES_PATH,
  arrayOf,
  listDeployment,
} from '../../lib/deployments'
import type { LiveResource } from '../../lib/deployments'
import { umbrellaErrorMessage } from '../../lib/umbrellaApi'
import type { UmbrellaClient } from '../../lib/umbrellaApi'

export type PolicyType = 'dns' | 'web'
export const POLICY_TYPES: PolicyType[] = ['dns', 'web']

/** Runtime + type guard — used by validate.ts to flag an unknown value AND to
 * safely narrow a spec's raw (possibly invalid) policyType before deploy/drift
 * index into a Map<PolicyType, ...>. */
export function isPolicyType(v: string): v is PolicyType {
  return (POLICY_TYPES as string[]).includes(v)
}

/** One policy assignment declared on the canvas (one item). `policyType` is
 * the RAW declared value (only defaulted when blank) so validate.ts can flag
 * an unrecognized one instead of it being silently coerced away. */
export interface PolicyAssignmentSpec {
  itemId?: string
  /** Name of the Internal Network Subnet identity (this app's
   * internal-network-subnets config type, matched by NAME). */
  identityName: string
  policyType: string
  /** Name of the DNS or Web policy (matched by NAME within its type). */
  policyName: string
}

/** A policy as returned by GET /deployments/v2/policies?type=dns|web. */
export interface LivePolicy {
  policyId?: number | string
  name?: string
  priority?: number
  isDefault?: boolean
}

/** A policy as returned by GET /deployments/v2/internalnetworks/{id}/policies. */
export interface LiveIdentityPolicy {
  id?: number | string
  name?: string
  type?: string
  isDefault?: boolean
  isAppliedDirectly?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Defaults only when blank — preserves an unrecognized value so validate.ts
 * can flag it, matching the app's `access: string` convention (destination-lists). */
function asPolicyType(v: unknown): string {
  return asString(v).toLowerCase() || 'dns'
}

export function extractPolicyAssignmentSpecs(canvas: CanvasSnapshot): PolicyAssignmentSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    identityName: asString(item.fields?.identityName) || item.name,
    policyType: asPolicyType(item.fields?.policyType),
    policyName: asString(item.fields?.policyName),
  }))
}

/** Composite identity key for a declared assignment (identity + policy type + policy name). */
export function assignmentKey(spec: Pick<PolicyAssignmentSpec, 'identityName' | 'policyType' | 'policyName'>): string {
  return `${spec.identityName.toLowerCase()}::${spec.policyType}::${spec.policyName.toLowerCase()}`
}

/** GET /deployments/v2/policies?type=dns|web, paged. Bare-array (per the
 * Deployments API convention), with an extra "type" query param the generic
 * listDeployment() helper doesn't support. */
export async function listPolicies(
  client: UmbrellaClient,
  policyType: PolicyType,
  maxPages = 20,
): Promise<{ ok: boolean; items: LivePolicy[]; lastError?: string }> {
  const items: LivePolicy[] = []
  for (let page = 1; page <= maxPages; page++) {
    const res = await client.get(DEPLOYMENTS_POLICIES_PATH, { type: policyType, page, limit: 100 })
    if (!res.ok) return { ok: false, items, lastError: umbrellaErrorMessage(res) }
    const rows = arrayOf<LivePolicy>(res.body)
    items.push(...rows)
    if (rows.length < 100) break
  }
  return { ok: true, items }
}

/** GET /deployments/v2/internalnetworks/{originId}/policies — the policies
 * (both types) currently applied to one Internal Network Subnet identity. */
export async function listIdentityPolicies(
  client: UmbrellaClient,
  originId: number | string,
): Promise<{ ok: boolean; items: LiveIdentityPolicy[] }> {
  const res = await client.get(`${DEPLOYMENTS_INTERNAL_NETWORK_SUBNETS_PATH}/${encodeURIComponent(String(originId))}/policies`)
  if (!res.ok) return { ok: false, items: [] }
  return { ok: true, items: arrayOf<LiveIdentityPolicy>(res.body) }
}

/** Resolve every distinct Internal Network Subnet NAME referenced by `specs`
 * to its opaque originId, by listing /deployments/v2/internalnetworks once. */
export async function resolveIdentityOriginIds(
  client: UmbrellaClient,
  names: string[],
): Promise<Map<string, number | string>> {
  const byName = new Map<string, number | string>()
  const listed = await listDeployment<LiveResource>(client, DEPLOYMENTS_INTERNAL_NETWORK_SUBNETS_PATH)
  if (!listed.ok) return byName
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  for (const live of listed.items) {
    const name = asString((live as Record<string, unknown>).name)
    const id = (live as Record<string, unknown>).originId as number | string | undefined
    if (name && id != null && wanted.has(name.toLowerCase())) byName.set(name.toLowerCase(), id)
  }
  return byName
}

/** Resolve every distinct (policyType, policyName) pair referenced by `specs`
 * to its opaque policyId, listing each policy type at most once. */
export async function resolvePolicyIds(
  client: UmbrellaClient,
  types: PolicyType[],
): Promise<Map<PolicyType, Map<string, number | string>>> {
  const result = new Map<PolicyType, Map<string, number | string>>()
  for (const type of types) {
    const listed = await listPolicies(client, type)
    const byName = new Map<string, number | string>()
    if (listed.ok) {
      for (const p of listed.items) {
        const name = asString(p.name)
        if (name && p.policyId != null) byName.set(name.toLowerCase(), p.policyId)
      }
    }
    result.set(type, byName)
  }
  return result
}
