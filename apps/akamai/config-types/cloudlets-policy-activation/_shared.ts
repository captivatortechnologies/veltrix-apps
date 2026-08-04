// Shared helpers for the Akamai Cloudlets Policy Activation config type.
// Activation is a SEPARATE step from managing policy/version content (the
// cloudlets-policies type): it promotes one policy VERSION onto STAGING or
// PRODUCTION.
//
// Endpoints (Cloudlets API v3, EdgeGrid-signed):
//   activate/deactivate: POST /cloudlets/v3/policies/{id}/activations
//                         { operation: "ACTIVATION" | "DEACTIVATION", network, policyVersion }
//   effective state:     GET  /cloudlets/v3/policies/{id}
//                         → currentActivations.{production,staging}.effective.policyVersion
//
// Unlike Network List Activation, Cloudlets exposes a REAL deactivation
// operation on the same endpoint — so rollback here can genuinely undo an
// activation (re-activate the prior version, or deactivate if there was
// none), rather than the honest forward-only no-op Network List Activation
// documents. The policy is resolved by NAME (its stable identity, shared with
// the cloudlets-policies type) via the collection endpoint.

import { policyPath, type CloudletPolicy } from '../cloudlets-policies/_shared'

export { contentFromResponse, findPolicy, policiesPath, type CloudletPolicy } from '../cloudlets-policies/_shared'

/** The two Cloudlets activation networks. */
export const NETWORKS = new Set(['STAGING', 'PRODUCTION'])

/** Normalize a network value from the canvas to STAGING or PRODUCTION (defaults to STAGING). */
export function normalizeNetwork(value: unknown): string {
  const n = String(value ?? '').trim().toUpperCase()
  return NETWORKS.has(n) ? n : 'STAGING'
}

/** Build the activations endpoint path for a policy. */
export function policyActivationsPath(policyId: number): string {
  return `${policyPath(policyId)}/activations`
}

export interface ActivationFields {
  policyName: string
  network: string
  policyVersion: number
}

/** Read + normalize the canvas fields for one activation item. */
export function readActivationFields(fields: Record<string, unknown>): ActivationFields {
  const versionRaw = fields.policyVersion
  return {
    policyName: String(fields.policyName ?? '').trim(),
    network: normalizeNetwork(fields.network),
    policyVersion: typeof versionRaw === 'number' && Number.isFinite(versionRaw) ? versionRaw : Number(versionRaw) || 0,
  }
}

/** This policy's `currentActivations` entry for a network (production/staging). */
function activationInfo(policy: CloudletPolicy, network: string) {
  return network.toUpperCase() === 'PRODUCTION' ? policy.currentActivations?.production : policy.currentActivations?.staging
}

/**
 * The version currently EFFECTIVE (live) for a policy on a network, from the
 * Policy resource's `currentActivations` — null when never activated there.
 */
export function effectiveVersion(policy: CloudletPolicy, network: string): number | null {
  return activationInfo(policy, network)?.effective?.policyVersion ?? null
}

/** Is the most recent activation request for this policy + network still in flight? */
export function isPending(policy: CloudletPolicy, network: string): boolean {
  return activationInfo(policy, network)?.latest?.status === 'IN_PROGRESS'
}
