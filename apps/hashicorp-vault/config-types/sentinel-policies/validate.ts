import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault Sentinel policy constraints (Vault ENTERPRISE only) ---------------
//
// See: https://developer.hashicorp.com/vault/api-docs/system/policies
// RGP (Role Governance Policies, /sys/policies/rgp) apply to the ACTING
// IDENTITY regardless of which path it hits. EGP (Endpoint Governance
// Policies, /sys/policies/egp) apply to specific request PATHS regardless of
// who hits them (`paths` is required for EGP and rejected for RGP). Both are
// authored in HashiCorp's Sentinel policy language — DISTINCT from an ACL
// policy's HCL (config-types/policies) and a password policy's HCL
// (config-types/password-policies).

/** The two Sentinel policy scopes this config type manages, each its own API namespace. */
export const SENTINEL_SCOPES = ['rgp', 'egp'] as const
export type SentinelScope = (typeof SENTINEL_SCOPES)[number]

/** A Sentinel policy name is `[A-Za-z0-9_-]+` — mirrors Vault's other policy-name rules. */
export const POLICY_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/** Allowed `enforcement_level` values for both RGP and EGP. */
export const ENFORCEMENT_LEVELS = ['advisory', 'soft-mandatory', 'hard-mandatory'] as const

// --- Basic client-side Sentinel sanity check ----------------------------------
//
// There is NO server-side dry-run for a Sentinel policy; the real gate is
// Vault's rejection on write. This is a light structural check — NOT a
// Sentinel parser: the body must be non-empty, have balanced braces, and
// declare a top-level `main` rule/variable (Sentinel's required pass/fail
// signal). Anything subtler is left to Vault.

export type SentinelHclReason = 'empty' | 'unbalanced_braces' | 'missing_main'

const MAIN_PATTERN = /\bmain\s*=/

/**
 * Run the basic Sentinel checks; returns `{ ok: true }` or the first failure
 * reason. NB: a non-union `{ ok; reason? }` (not a discriminated union) — the
 * platform's handler loader does not narrow discriminated unions, so accessing
 * `.reason` after `if (!check.ok)` must not depend on narrowing.
 */
export function checkSentinelPolicy(policy: string): { ok: boolean; reason?: SentinelHclReason } {
  const trimmed = policy.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }

  let depth = 0
  for (const ch of trimmed) {
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth < 0) return { ok: false, reason: 'unbalanced_braces' }
    }
  }
  if (depth !== 0) return { ok: false, reason: 'unbalanced_braces' }

  if (!MAIN_PATTERN.test(trimmed)) return { ok: false, reason: 'missing_main' }

  return { ok: true }
}

/**
 * Canonicalize a Sentinel policy body for drift comparison: strip `#` line
 * comments and collapse all whitespace. Vault stores what you send, but a
 * policy edited out-of-band may be reformatted, so raw string compare = false
 * drift. Both the deployed and the live body pass through this before
 * comparing. Mirrors config-types/policies' normalizePolicy.
 */
export function normalizeSentinelPolicy(policy: string): string {
  return policy
    .replace(/#[^\r\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SentinelPolicySpec {
  sectionName: string
  /** 'rgp' | 'egp' — selects /sys/policies/rgp vs /sys/policies/egp. Part of the identity. */
  scope: SentinelScope | ''
  /** Policy name — the identity within its scope (rgp and egp are separate namespaces). */
  name: string
  /** Raw Sentinel policy body — sent verbatim to Vault. */
  policy: string
  /** advisory | soft-mandatory | hard-mandatory. */
  enforcementLevel: string
  /** EGP only — the paths (glob-capable) this policy applies to. Empty/ignored for RGP. */
  paths: string[]
}

/** Shape of a policy returned by GET /sys/policies/{rgp|egp}/{name} (under `data`). */
export interface LiveSentinelPolicy {
  name?: string
  policy?: string
  enforcement_level?: string
  /** EGP only. */
  paths?: string[]
}

/** Normalize a raw scope value to a known SentinelScope, or '' when unrecognized. */
function normalizeScope(value: unknown): SentinelScope | '' {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (SENTINEL_SCOPES as readonly string[]).includes(s) ? (s as SentinelScope) : ''
}

/** Normalize a list value — canvas `tags` fields arrive as arrays (or comma/newline text). */
export function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** The composite policy identity "scope/name" — the dedup + match key. */
export function sentinelKey(scope: string, name: string): string {
  return `${scope}/${name}`
}

/** Each canvas item describes one Vault Sentinel (RGP or EGP) policy. */
export function extractSentinelPolicySpecs(canvas: CanvasSnapshot): SentinelPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      scope: normalizeScope(fields.scope),
      name: typeof fields.name === 'string' ? fields.name.trim().toLowerCase() : '',
      policy: typeof fields.policy === 'string' ? fields.policy.trim() : '',
      enforcementLevel: typeof fields.enforcementLevel === 'string' ? fields.enforcementLevel.trim() : '',
      paths: normalizeList(fields.paths),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Sentinel policy configurations against Vault's constraints (no
 * network): scope, name and a Sentinel body (passing the basic structural
 * checks) are required, enforcementLevel is one of the three known values,
 * (scope, name) — the policy's identity — is unique per canvas (rgp and egp
 * are separate namespaces, so the same name may exist in both), and `paths` is
 * REQUIRED for egp but must be EMPTY for rgp (Vault has no `paths` concept for
 * a role governance policy).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSentinelPolicySpecs(ctx.canvas)
  const seenKeys = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // scope — required, one of rgp | egp
    if (!spec.scope) {
      errors.push({ field: `${prefix}.scope`, message: 'Policy scope is required (rgp or egp)', code: 'required' })
    }

    // name — required, `[A-Za-z0-9_-]+`
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else if (!POLICY_NAME_PATTERN.test(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Policy name may only contain letters, numbers, underscores and hyphens',
        code: 'invalid_name',
      })
    }

    // (scope, name) is the identity — dedupe on the composite key (rgp/foo and egp/foo coexist).
    if (spec.scope && spec.name) {
      const key = sentinelKey(spec.scope, spec.name)
      if (seenKeys.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate Sentinel policy "${key}" — each (scope, name) policy may only be declared once per canvas`,
          code: 'duplicate_policy',
        })
      }
      seenKeys.add(key)
    }

    // policy — required Sentinel body, passing the basic structural checks
    if (!spec.policy) {
      errors.push({ field: `${prefix}.policy`, message: 'Sentinel policy body is required', code: 'required' })
    } else {
      const check = checkSentinelPolicy(spec.policy)
      if (!check.ok) {
        if (check.reason === 'unbalanced_braces') {
          errors.push({
            field: `${prefix}.policy`,
            message: 'Sentinel policy has unbalanced braces — every "{" needs a matching "}"',
            code: 'unbalanced_braces',
          })
        } else if (check.reason === 'missing_main') {
          errors.push({
            field: `${prefix}.policy`,
            message: 'Sentinel policy must declare a top-level "main" rule or variable, e.g. main = rule { ... }',
            code: 'missing_main',
          })
        }
      }
    }

    // enforcementLevel — required, one of the three known values
    if (!spec.enforcementLevel) {
      errors.push({
        field: `${prefix}.enforcementLevel`,
        message: `Enforcement level is required (one of ${ENFORCEMENT_LEVELS.join(', ')})`,
        code: 'required',
      })
    } else if (!(ENFORCEMENT_LEVELS as readonly string[]).includes(spec.enforcementLevel)) {
      errors.push({
        field: `${prefix}.enforcementLevel`,
        message: `Enforcement level must be one of ${ENFORCEMENT_LEVELS.join(', ')}`,
        code: 'invalid_enforcement_level',
      })
    }

    // paths — REQUIRED for egp, NOT ALLOWED for rgp.
    if (spec.scope === 'egp' && spec.paths.length === 0) {
      errors.push({
        field: `${prefix}.paths`,
        message: 'At least one path is required for an EGP policy (e.g. "secret/*", or "*" for every request)',
        code: 'required',
      })
    }
    if (spec.scope === 'rgp' && spec.paths.length > 0) {
      errors.push({
        field: `${prefix}.paths`,
        message: 'Paths are not valid for an RGP policy (Role Governance Policies apply to the acting identity, not request paths) — clear this field or set scope to egp',
        code: 'paths_not_allowed',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
