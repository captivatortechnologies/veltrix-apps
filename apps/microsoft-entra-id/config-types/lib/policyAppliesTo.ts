// =============================================================================
// "appliesTo" — shared live picker + id-aware resolver + provenance-tracked
// $ref reconcile for the FIVE Entra policy types that are assigned to
// applications and/or service principals via a directoryObject relationship
// (Phase-2 batch-3):
//
//   policy type                base(s) written to           relationship name
//   appManagementPolicy        /applications OR              appManagementPolicies
//                               /servicePrincipals
//   claimsMappingPolicy        /servicePrincipals only        claimsMappingPolicies
//   tokenIssuancePolicy        /applications only              tokenIssuancePolicies
//   tokenLifetimePolicy        /servicePrincipals only        tokenLifetimePolicies
//   homeRealmDiscoveryPolicy   /servicePrincipals only        homeRealmDiscoveryPolicies
//
// VERIFIED per-type (not assumed):
//  - appManagementPolicy: assign = POST /applications/{id}/appManagementPolicies/$ref
//    OR POST /servicePrincipals/{id}/appManagementPolicies/$ref, body
//    {"@odata.id":".../policies/appManagementPolicies/{id}"}. "Only one policy
//    object can be assigned to an application or service principal."
//    (https://learn.microsoft.com/graph/api/appmanagementpolicy-post-appliesto).
//    Unassign = DELETE .../appManagementPolicies/{policyId}/$ref on either base
//    (https://learn.microsoft.com/graph/api/appmanagementpolicy-delete-appliesto).
//  - claimsMappingPolicy: SERVICE-PRINCIPAL-ONLY. assign = POST
//    /servicePrincipals/{id}/claimsMappingPolicies/$ref
//    (https://learn.microsoft.com/graph/api/serviceprincipal-post-claimsmappingpolicies).
//    Its own resource page's isOrganizationDefault note confirms this: "The
//    claims-mapping policy can only be applied to service principals."
//    Unassign = DELETE .../claimsMappingPolicies/{policyId}/$ref
//    (https://learn.microsoft.com/graph/api/serviceprincipal-delete-claimsmappingpolicies).
//  - tokenIssuancePolicy: APPLICATION-ONLY — the INVERSE of what its own
//    resource page's isOrganizationDefault text claims ("can only be applied
//    to service principals", copy-pasted from claimsMappingPolicy's page and
//    WRONG for this resource). Verified directly: `GET
//    serviceprincipal-post-tokenissuancepolicies` 404s (no such operation
//    page exists), while `application-post-tokenissuancepolicies` is a fully
//    documented, real operation: POST
//    /applications/{id}/tokenIssuancePolicies/$ref
//    (https://learn.microsoft.com/graph/api/application-post-tokenissuancepolicies).
//    Unassign = DELETE .../tokenIssuancePolicies/{policyId}/$ref
//    (https://learn.microsoft.com/graph/api/application-delete-tokenissuancepolicies).
//    This is the one genuine surprise this batch turned up — see the phase
//    report for detail. Trust the dedicated operation pages over a resource
//    page's boilerplate property description when the two disagree.
//  - tokenLifetimePolicy: SERVICE-PRINCIPAL-ONLY. assign = POST
//    /servicePrincipals/{id}/tokenLifetimePolicies/$ref. "You can have
//    multiple tokenLifetimePolicy policies in a tenant but can assign only
//    one tokenLifetimePolicy per service principal."
//    (https://learn.microsoft.com/graph/api/serviceprincipal-post-tokenlifetimepolicies).
//    Unassign = DELETE .../tokenLifetimePolicies/{policyId}/$ref
//    (https://learn.microsoft.com/graph/api/serviceprincipal-delete-tokenlifetimepolicies).
//  - homeRealmDiscoveryPolicy: SERVICE-PRINCIPAL-ONLY. assign = POST
//    /servicePrincipals/{id}/homeRealmDiscoveryPolicies/$ref
//    (https://learn.microsoft.com/graph/api/serviceprincipal-post-homerealmdiscoverypolicies).
//    Unassign = DELETE .../homeRealmDiscoveryPolicies/{policyId}/$ref
//    (https://learn.microsoft.com/graph/api/serviceprincipal-delete-homerealmdiscoverypolicies).
//
// Reading current assignment reads from the POLICY side (not by enumerating
// every application/servicePrincipal in the tenant):
//   GET /policies/{policyTypeName}/{policyId}/appliesTo
// which returns a directoryObject collection tagged with a real
// `@odata.type` discriminator (confirmed on the appManagementPolicy example:
// "#microsoft.graph.application" / "#microsoft.graph.servicePrincipal" —
// https://learn.microsoft.com/graph/api/appmanagementpolicy-list-appliesto)
// — used here to recover each target's kind without a second live-set lookup.
//
// All five write endpoints reference the policy object by object id, and this
// module always addresses application/servicePrincipal TARGETS by their
// object id too (never an application's appId) — the same "don't mix id
// spaces in one field" discipline entraOptions.ts's header documents for
// `applications` vs `applicationObjects`.
//
// GRAPH-ENFORCED CARDINALITY THIS CODE CANNOT VALIDATE OFFLINE: each of these
// five relationships allows at most ONE policy of that type per target. If a
// target already carries a DIFFERENT policy of the same type (assigned by
// hand, or by a different canvas item), the assign POST fails — surfaced
// as a Graph error via graphErrorMessage, not a local validation error, the
// same "can't check offline" precedent conditional-access-policies already
// sets for its built-in-role-only Conditional Access restriction.
// =============================================================================

import type { OptionItem, OptionsProviderContext } from '@veltrixsecops/app-sdk'
import { graphErrorMessage, type GraphClient } from '../../lib/graph'
import entraOptions from './entraOptions'
import { buildApplicationObjectNameToId, buildServicePrincipalNameToId, isGuid } from './nameMaps'

function withKind(o: OptionItem, kind: string): OptionItem {
  return { ...o, label: `${o.label} (${kind})` }
}

/** Live options for the merged "applicationOrServicePrincipal" alias source
 *  (app-management-policies' appliesTo field — the one policy type
 *  assignable to EITHER kind). Object ids only (applicationObjects, not
 *  appId-valued applications) so both kinds share one id space. */
export async function applicationOrServicePrincipalOptions(ctx: OptionsProviderContext): Promise<OptionItem[]> {
  const [applications, servicePrincipals] = await Promise.all([
    entraOptions({ ...ctx, source: 'applicationObjects' }),
    entraOptions({ ...ctx, source: 'servicePrincipals' }),
  ])
  return [
    ...applications.map((o) => withKind(o, 'application')),
    ...servicePrincipals.map((o) => withKind(o, 'service principal')),
  ]
}

export type PolicyTargetKind = 'application' | 'servicePrincipal'

export interface PolicyTarget {
  id: string
  kind: PolicyTargetKind
}

/** A tracked appliesTo assignment, with provenance (mirrors administrative-units' MemberEntry). */
export interface PolicyAppliesToEntry extends PolicyTarget {
  /** false = this app assigned the policy here; true = it was already assigned before this app touched it. */
  existed: boolean
}

const TARGET_BASE: Record<PolicyTargetKind, string> = {
  application: '/applications',
  servicePrincipal: '/servicePrincipals',
}

function kindFromODataType(t: unknown): PolicyTargetKind | null {
  if (t === '#microsoft.graph.application') return 'application'
  if (t === '#microsoft.graph.servicePrincipal') return 'servicePrincipal'
  return null
}

export interface PolicyTargetMaps {
  appNameToId: Map<string, string>
  appIds: Set<string>
  spNameToId: Map<string, string>
  spIds: Set<string>
}

/** Build the application/servicePrincipal object-id name maps (and their id
 *  sets) once per deploy/drift run — used to resolve a hand-typed name AND to
 *  classify a picker-selected/hand-typed GUID's kind (a bare id carries no
 *  kind marker of its own). */
export async function buildPolicyTargetMaps(client: GraphClient): Promise<PolicyTargetMaps> {
  const [appNameToId, spNameToId] = await Promise.all([
    buildApplicationObjectNameToId(client),
    buildServicePrincipalNameToId(client),
  ])
  return {
    appNameToId,
    appIds: new Set(appNameToId.values()),
    spNameToId,
    spIds: new Set(spNameToId.values()),
  }
}

/** Resolve one appliesTo value to a kind-tagged target: GUID passthrough
 *  (kind determined by live id-set membership), else resolve a hand-typed
 *  display name (kind determined by which map matched). */
export function resolvePolicyTarget(
  value: string,
  maps: PolicyTargetMaps,
  allowedKinds: readonly PolicyTargetKind[]
): { target: PolicyTarget | null; missing: boolean } {
  const v = (value ?? '').trim()
  if (!v) return { target: null, missing: false }

  if (isGuid(v)) {
    if (allowedKinds.includes('application') && maps.appIds.has(v)) {
      return { target: { id: v, kind: 'application' }, missing: false }
    }
    if (allowedKinds.includes('servicePrincipal') && maps.spIds.has(v)) {
      return { target: { id: v, kind: 'servicePrincipal' }, missing: false }
    }
    return { target: null, missing: true }
  }

  const lower = v.toLowerCase()
  if (allowedKinds.includes('application')) {
    const appId = maps.appNameToId.get(lower)
    if (appId) return { target: { id: appId, kind: 'application' }, missing: false }
  }
  if (allowedKinds.includes('servicePrincipal')) {
    const spId = maps.spNameToId.get(lower)
    if (spId) return { target: { id: spId, kind: 'servicePrincipal' }, missing: false }
  }
  return { target: null, missing: true }
}

/** Batch form of resolvePolicyTarget, for the appliesTo multiselect field. */
export function resolvePolicyTargets(
  values: string[],
  maps: PolicyTargetMaps,
  allowedKinds: readonly PolicyTargetKind[]
): { targets: PolicyTarget[]; missing: string[] } {
  const targets: PolicyTarget[] = []
  const missing: string[] = []
  for (const v of values) {
    const r = resolvePolicyTarget(v, maps, allowedKinds)
    if (r.missing) missing.push(v)
    else if (r.target) targets.push(r.target)
  }
  return { targets, missing }
}

/** GET the policy's current appliesTo targets, kind-tagged from `@odata.type`. */
export async function listPolicyAppliesTo(
  client: GraphClient,
  policyTypeName: string,
  policyId: string
): Promise<{ ok: boolean; targets: PolicyTarget[] }> {
  const listed = await client.getAll<{ id?: string; '@odata.type'?: string }>(
    `/policies/${policyTypeName}/${policyId}/appliesTo`
  )
  if (!listed.ok) return { ok: false, targets: [] }
  const targets: PolicyTarget[] = []
  for (const item of listed.items) {
    const kind = kindFromODataType(item['@odata.type'])
    if (item.id && kind) targets.push({ id: item.id, kind })
  }
  return { ok: true, targets }
}

/**
 * Reconcile one policy's appliesTo assignments to the declared target set.
 *
 * Adds a missing assignment via POST {targetBase}/{id}/{policyTypeName}/$ref
 * referencing the policy's own id. Removes ONLY assignments THIS app itself
 * made (existed:false) that are no longer declared — an assignment that
 * already existed before this app touched it is left alone, mirroring
 * administrative-units' reconcileMembers.
 */
export async function reconcilePolicyAppliesTo(
  client: GraphClient,
  policyTypeName: string,
  policyId: string,
  desired: PolicyTarget[],
  priorEntries: PolicyAppliesToEntry[]
): Promise<{ entries: PolicyAppliesToEntry[]; failures: string[] }> {
  const live = await listPolicyAppliesTo(client, policyTypeName, policyId)
  if (!live.ok) {
    return { entries: priorEntries, failures: ['could not list current appliesTo assignments — left unchanged'] }
  }

  const liveIds = new Set(live.targets.map((t) => t.id))
  const priorById = new Map(priorEntries.map((p) => [p.id, p]))
  const desiredIds = new Set(desired.map((d) => d.id))
  const entries: PolicyAppliesToEntry[] = []
  const failures: string[] = []

  for (const target of desired) {
    if (liveIds.has(target.id)) {
      entries.push({ ...target, existed: priorById.get(target.id)?.existed ?? true })
      continue
    }
    const resp = await client.post(`${TARGET_BASE[target.kind]}/${target.id}/${policyTypeName}/$ref`, {
      '@odata.id': `https://graph.microsoft.com/v1.0/policies/${policyTypeName}/${policyId}`,
    })
    if (!resp.ok) {
      failures.push(`assign to ${target.id}: ${graphErrorMessage(resp)}`)
      continue
    }
    entries.push({ ...target, existed: false })
  }

  for (const p of priorEntries) {
    if (p.existed || desiredIds.has(p.id) || !liveIds.has(p.id)) continue
    const resp = await client.delete(`${TARGET_BASE[p.kind]}/${p.id}/${policyTypeName}/${policyId}/$ref`)
    if (!resp.ok && resp.status !== 404) {
      failures.push(`unassign from ${p.id}: ${graphErrorMessage(resp)}`)
    }
  }

  return { entries, failures }
}
