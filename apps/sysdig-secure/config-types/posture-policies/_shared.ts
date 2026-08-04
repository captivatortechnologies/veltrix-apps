// Shared helpers for the Sysdig Secure Posture Policies config type
// (validate + deploy + rollback + drift).
//
// Policy shape follows the Sysdig Secure /api/cspm/v1/policy API (confirmed
// against terraform-provider-sysdig's v2 client + resource docs). Unlike
// Posture Controls, this API DOES expose a list-all-with-name endpoint
// (/api/cspm/v1/policy/policies/list), so this type follows the same
// by-name upsert pattern as the rest of this app.

import type { SysdigPostureRequirementGroup, SysdigPostureTarget, SysdigPosturePolicy, SysdigPosturePolicySummary } from '../../lib/sysdigApi'

export const POLICY_TYPES = new Set(['aws', 'gcp', 'azure', 'kubernetes', 'linux', 'docker', 'oci'])

export interface PosturePolicyFields {
  name?: unknown
  description?: unknown
  type?: unknown
  link?: unknown
  enabled?: unknown
  requirementGroupsJson?: unknown
  targetsJson?: unknown
}

export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'false' || s === '0' || s === 'no') return false
  if (s === 'true' || s === '1' || s === 'yes') return true
  return fallback
}

function tryParseArray(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function isMalformedJsonArray(value: unknown): boolean {
  const raw = String(value ?? '').trim()
  if (!raw) return false
  return tryParseArray(raw) === null
}

/** Parse `requirementGroupsJson` into the nested groups/requirements/controls tree. */
export function parseRequirementGroups(value: unknown): SysdigPostureRequirementGroup[] {
  const raw = String(value ?? '').trim()
  if (!raw) return []
  const parsed = tryParseArray(raw)
  if (!parsed) return []
  return parsed.map((g) => {
    const group = g as Record<string, unknown>
    return {
      name: String(group?.name ?? '').trim(),
      description: String(group?.description ?? '').trim(),
      requirements: Array.isArray(group?.requirements)
        ? (group.requirements as unknown[]).map((r) => {
            const req = r as Record<string, unknown>
            return {
              name: String(req?.name ?? '').trim(),
              description: String(req?.description ?? '').trim(),
              controls: Array.isArray(req?.controls)
                ? (req.controls as unknown[]).map((c) => {
                    const control = c as Record<string, unknown>
                    return { name: String(control?.name ?? '').trim(), enabled: control?.enabled !== false }
                  })
                : [],
            }
          })
        : [],
    }
  })
}

/** Parse `targetsJson` into version-constraint entries. */
export function parseTargets(value: unknown): SysdigPostureTarget[] {
  const raw = String(value ?? '').trim()
  if (!raw) return []
  const parsed = tryParseArray(raw)
  if (!parsed) return []
  return parsed.map((t) => {
    const target = t as Record<string, unknown>
    return {
      platform: target?.platform !== undefined ? String(target.platform).trim() : undefined,
      minVersion: typeof target?.minVersion === 'number' ? target.minVersion : undefined,
      maxVersion: typeof target?.maxVersion === 'number' ? target.maxVersion : undefined,
    }
  })
}

/** Build the Sysdig posture-policy body from canvas fields. `id` set updates in place. */
export function buildPolicyBody(fields: PosturePolicyFields, id?: string): SysdigPosturePolicy {
  return {
    ...(id ? { id } : {}),
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    type: String(fields.type ?? 'aws').trim(),
    link: String(fields.link ?? '').trim() || undefined,
    groups: parseRequirementGroups(fields.requirementGroupsJson),
    targets: parseTargets(fields.targetsJson),
  }
}

/** Find a policy in the list-all-with-name response by exact name. */
export function findPolicySummaryByName(policies: SysdigPosturePolicySummary[], name: string): SysdigPosturePolicySummary | null {
  const n = name.trim()
  if (!n) return null
  return policies.find((p) => String(p.name ?? '').trim() === n) ?? null
}
