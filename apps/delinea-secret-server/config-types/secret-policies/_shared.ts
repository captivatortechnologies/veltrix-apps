// Shared helpers for the Secret Server Secret Policies config type (deploy +
// rollback + drift + health). Policy shapes follow the Secret Server v1 REST API
// (/api/v1/secret-policy).
//
// VERIFIED against the Delinea/Thycotic PowerShell module source
// (thycotic-ps/thycotic.secretserver — New/Set/Get/Search-TssSecretPolicy):
//   search  GET   /api/v1/secret-policy/search?filter.secretPolicyName=<name>
//   read    GET   /api/v1/secret-policy/{id}
//   create  POST  /api/v1/secret-policy        { data: { secretPolicyName, ... } }
//   update  PATCH /api/v1/secret-policy/{id}    { data: { <field>: { dirty, value } } }
// Record keys: secretPolicyId / secretPolicyName / secretPolicyDescription / active.
// Requires Secret Server 11.0.000005+ for create/read/update (search: 10.9+).
// Verify request/response field names against a live Secret Server instance.

import {
  listAllRecords,
  normalizeBool,
  type SecretServerClient,
} from '../../lib/secretServerApi'

/** One secret policy as returned by GET /api/v1/secret-policy/search or /{id}. */
export interface LivePolicy {
  secretPolicyId?: number | string
  secretPolicyName?: string
  secretPolicyDescription?: string
  active?: boolean
  [key: string]: unknown
}

/** One secret policy declared by a canvas item. */
export interface PolicySpec {
  secretPolicyName: string
  secretPolicyDescription: string
  active: boolean
  comment: string
}

/** A canvas item shape (id/name optional; only fields are read). */
export interface CanvasItemLike {
  fields: Record<string, unknown>
}

export function policyNameOf(p: LivePolicy): string {
  return String(p.secretPolicyName ?? '')
}

/** A live policy's numeric id, or null when absent / non-numeric. */
export function policyIdOf(p: LivePolicy): number | null {
  const raw = p.secretPolicyId
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Map canvas items to policy specs. */
export function extractPolicySpecs(items: CanvasItemLike[]): PolicySpec[] {
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      secretPolicyName: String(f.secretPolicyName ?? '').trim(),
      secretPolicyDescription: String(f.secretPolicyDescription ?? '').trim(),
      active: normalizeBool(f.active),
      comment: String(f.comment ?? '').trim(),
    }
  })
}

/**
 * Search secret policies, optionally filtered by name, across every page.
 * `filter.includeInactive=true` so an existing-but-disabled policy is still
 * matched (upsert must find it). Throws on a non-OK response.
 */
export async function searchPolicies(client: SecretServerClient, name?: string): Promise<LivePolicy[]> {
  const query: Record<string, string | number | boolean> = { 'filter.includeInactive': true }
  if (name) query['filter.secretPolicyName'] = name
  return listAllRecords<LivePolicy>(client, '/secret-policy/search', query)
}

/** Find a live policy by name (case-insensitive). */
export function findPolicyByName(policies: LivePolicy[], name: string): LivePolicy | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return policies.find((p) => policyNameOf(p).trim().toLowerCase() === n) ?? null
}

/** Body for POST /api/v1/secret-policy (create). Fields nest under `data`. */
export function buildPolicyCreateBody(spec: PolicySpec): Record<string, unknown> {
  return {
    data: {
      secretPolicyName: spec.secretPolicyName,
      secretPolicyDescription: spec.secretPolicyDescription,
      active: spec.active,
    },
  }
}

/**
 * Body for PATCH /api/v1/secret-policy/{id} (update the managed fields). Secret
 * Server's policy grid-patch wraps each changed field in { dirty, value }.
 */
export function buildPolicyUpdateBody(spec: PolicySpec): Record<string, unknown> {
  return {
    data: {
      secretPolicyName: { dirty: true, value: spec.secretPolicyName },
      secretPolicyDescription: { dirty: true, value: spec.secretPolicyDescription },
      active: { dirty: true, value: spec.active },
    },
  }
}

/** Restore body for a prior policy — only the fields this app manages. */
export function buildPolicyRestoreBody(prior: LivePolicy): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  if (prior.secretPolicyName !== undefined) data.secretPolicyName = { dirty: true, value: prior.secretPolicyName }
  if (prior.secretPolicyDescription !== undefined) {
    data.secretPolicyDescription = { dirty: true, value: prior.secretPolicyDescription }
  }
  if (prior.active !== undefined) data.active = { dirty: true, value: normalizeBool(prior.active) }
  return { data }
}
