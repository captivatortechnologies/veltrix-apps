// =============================================================================
// Shared helpers for the Cisco Meraki Group Policies config type.
//
// Unlike the firewall-rules config types, a group policy is a PER-OBJECT
// resource: Meraki assigns each one a server-side `groupPolicyId` on create,
// and a network can hold many of them. This config type therefore reconciles
// by NAME (per network) — list the network's policies, match a live one by
// name, then update it (PUT) or create it (POST) — the same shape as Wiz's
// wiz-cloud-config-rules config type.
//
// The group policy schema itself (scheduling, bandwidth, firewallAndTraffic-
// Shaping, contentFiltering, splashAuthSettings, vlanTagging, bonjourForwarding)
// is large and deeply nested. Rather than flattening dozens of nested canvas
// fields, this follows Cribl's Sources/Destinations `{ id, type, ...conf }`
// precedent: `name` is a typed, required canvas field (the identity), and
// everything else is authored as ONE JSON blob (`policy`) that is spread onto
// the request body as `{ name, ...policy }`. `name` / `groupPolicyId` inside
// that blob are stripped — the canvas `name` field and Meraki's own assigned id
// always win.
//
// NOTE: the schema follows the documented Meraki Dashboard API v1
// (https://developer.cisco.com/meraki/api-v1/create-network-group-policy/,
// https://developer.cisco.com/meraki/api-v1/get-network-group-policies/).
// Only the well-known top-level `*.settings` enums are validated here (see
// validate.ts) — the full nested schema (scheduling days, traffic-shaping
// rule definitions, content-filtering patterns, bonjour rules, ...) is passed
// through as declared; Meraki itself validates it at deploy time. Verify
// against a live Meraki organization.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { networkIdKey, parseJsonObject } from '../../lib/merakiCommon'

export { networkIdKey, parseJsonObject }

/** Keys inside the `policy` JSON blob that are ignored — identity is owned elsewhere. */
export const IGNORED_POLICY_KEYS = ['name', 'groupPolicyId'] as const

/**
 * A group policy as Meraki returns/accepts it. Loosely typed on purpose — the
 * nested schema is large, vendor-specific and evolving; every handler treats
 * it as an opaque bag of declared keys plus the two identity fields.
 */
export interface MerakiGroupPolicy {
  groupPolicyId?: string
  name?: string
  [key: string]: unknown
}

/** The policy's logical identity: its `name`, trimmed and lower-cased for matching. */
export function groupPolicyKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Strip the identity keys from a parsed policy blob before spreading it onto a request body. */
export function stripIdentityKeys(policy: Record<string, unknown>): Record<string, unknown> {
  const { name: _name, groupPolicyId: _id, ...rest } = policy
  return rest
}

/** Build the create/update request body: `{ name, ...policy }` with identity keys stripped from `policy`. */
export function buildGroupPolicyBody(name: string, policy: Record<string, unknown>): Record<string, unknown> {
  return { name: name.trim(), ...stripIdentityKeys(policy) }
}

/** The keys we declare on a policy (`name` + every key in the JSON blob) — used to scope drift comparison. */
export function declaredGroupPolicyKeys(policy: Record<string, unknown>): string[] {
  return ['name', ...Object.keys(stripIdentityKeys(policy))]
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface GroupPolicySpec {
  itemName: string
  networkId: string
  name: string
  policyRaw: unknown
}

/** Each canvas item describes one Meraki network's group policy. */
export function extractGroupPolicySpecs(canvas: CanvasSnapshot): GroupPolicySpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      itemName: item.name,
      networkId: str(fields.network_id),
      name: str(fields.name),
      policyRaw: fields.policy,
    }
  })
}
