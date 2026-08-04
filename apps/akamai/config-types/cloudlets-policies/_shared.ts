// Shared helpers for the Akamai Cloudlets Policies config type. Shapes follow
// the Cloudlets API v3 (shared policies only — the only kind v3 supports):
//   policies:  GET/POST /cloudlets/v3/policies, GET/PUT/DELETE /cloudlets/v3/policies/{id}
//   versions:  GET/POST /cloudlets/v3/policies/{id}/versions,
//              GET/PUT/DELETE /cloudlets/v3/policies/{id}/versions/{version}
//
// A policy is a PER-OBJECT resource — Akamai assigns each one a server-side
// numeric `id` on create — so this reconciles by NAME (list, match by name,
// then update/create), the same shape as Cisco Meraki's Group Policies. A
// policy VERSION is immutable once it has ever been activated, so rather than
// guessing draft-vs-immutable state, deploy always creates a NEW version when
// matchRules/description differ from the latest one — simpler and side-effect
// -safe at the cost of a new version number per edit (which Cloudlets'
// version history already expects). Activation is a SEPARATE config type
// (cloudlets-policy-activation), the same content/promotion split already
// used for Network Lists.
//
// The matchRules schema is large and cloudlet-type-specific (edgeRedirector,
// requestControl, apiPrioritization, …), so — following Cisco Meraki's Group
// Policies / Cribl's Sources-Destinations precedent — `matchRules` is authored
// as ONE JSON array blob rather than dozens of nested canvas fields; Cloudlets
// itself validates the nested shape at deploy time.

import { CLOUDLETS_POLICIES_PATH } from '../../lib/akamaiApi'

/** The six Cloudlet types the API v3 (shared policies) supports. */
export const CLOUDLET_TYPES = new Set(['AP', 'AS', 'CD', 'ER', 'FR', 'IG'])

/** One network's activation summary on a Policy resource — effective (live) and latest (most recent request). */
export interface ActivationInfo {
  effective?: { policyVersion?: number; status?: string } | null
  latest?: { policyVersion?: number; status?: string } | null
}

/** A shared policy as the API returns/accepts it (fields we rely on). */
export interface CloudletPolicy {
  id?: number
  name?: string
  cloudletType?: string
  groupId?: number
  description?: string | null
  policyType?: string
  currentActivations?: {
    production?: ActivationInfo
    staging?: ActivationInfo
  }
  [key: string]: unknown
}

/** A policy version as the API returns/accepts it. */
export interface CloudletPolicyVersion {
  id?: number
  policyId?: number
  version?: number
  description?: string | null
  matchRules?: unknown[]
  immutable?: boolean
  [key: string]: unknown
}

/** Unwrap the `{ content: [...] }` page envelope into a flat array. */
export function contentFromResponse<T>(payload: unknown): T[] {
  if (payload && typeof payload === 'object' && Array.isArray((payload as { content?: unknown }).content)) {
    return (payload as { content: T[] }).content
  }
  return Array.isArray(payload) ? (payload as T[]) : []
}

/** Find a live policy by (case-insensitive) name — the stable identity for upsert. */
export function findPolicy(policies: CloudletPolicy[], name: string): CloudletPolicy | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return policies.find((p) => String(p.name ?? '').trim().toLowerCase() === n) ?? null
}

/** The latest (highest-numbered) version for a policy, or null if it has none yet. */
export function latestVersion(versions: CloudletPolicyVersion[]): CloudletPolicyVersion | null {
  if (versions.length === 0) return null
  return versions.reduce((best, v) => ((v.version ?? -1) > (best.version ?? -1) ? v : best))
}

/**
 * Parse the `matchRules` JSON textarea into an array. Blank input is an empty
 * ruleset (a policy with no rules — valid, matches nothing). Throws a
 * descriptive error on malformed JSON or a non-array value.
 */
export function parseMatchRules(value: unknown): unknown[] {
  const raw = String(value ?? '').trim()
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Match rules must be valid JSON: ${error instanceof Error ? error.message : 'parse error'}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Match rules must be a JSON array (Cloudlets evaluates rules top-to-bottom).')
  }
  return parsed
}

/** Deep, order-sensitive equality for two matchRules arrays (rule order is meaningful). */
export function sameMatchRules(a: unknown[], b: unknown[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface CloudletPolicyFields {
  name: string
  cloudletType: string
  groupId: number
  description: string
  versionDescription: string
  matchRules: unknown[]
}

/** Read + normalize the canvas fields for one policy item. Throws if matchRules is malformed JSON. */
export function readPolicyFields(fields: Record<string, unknown>): CloudletPolicyFields {
  const groupIdRaw = fields.groupId
  return {
    name: String(fields.name ?? '').trim(),
    cloudletType: String(fields.cloudletType ?? '').trim().toUpperCase(),
    groupId: typeof groupIdRaw === 'number' && Number.isFinite(groupIdRaw) ? groupIdRaw : Number(groupIdRaw) || 0,
    description: String(fields.description ?? '').trim(),
    versionDescription: String(fields.versionDescription ?? '').trim(),
    matchRules: parseMatchRules(fields.matchRules),
  }
}

export const policiesPath = CLOUDLETS_POLICIES_PATH
export const policyPath = (policyId: number): string => `${CLOUDLETS_POLICIES_PATH}/${policyId}`
export const policyVersionsPath = (policyId: number): string => `${policyPath(policyId)}/versions`
export const policyVersionPath = (policyId: number, version: number): string => `${policyVersionsPath(policyId)}/${version}`
