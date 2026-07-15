import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault password (generation) policy constraints ---------------------------
//
// These are password GENERATION policies (POST /sys/policies/password/{name}) —
// the templates secret engines use to mint random passwords. They are DISTINCT
// from ACL policies (config-types/policies), which govern access. A password
// policy is authored in HCL and identified by its NAME.

/**
 * A password policy name is `[A-Za-z0-9_-]+`. Vault stores the name verbatim in
 * the path, so — unlike ACL policy names, which Vault case-folds — the name is
 * treated case-sensitively as the object's identity everywhere in this app.
 */
export const PASSWORD_POLICY_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

// --- Basic client-side HCL sanity check ---------------------------------------
//
// There is NO server-side dry-run for a password policy; the real gate is
// Vault's 400 on write. This is a light structural check — NOT an HCL parser:
// the body must be non-empty, declare a top-level `length = <int>`, contain at
// least one `rule "charset" { … }` block, and have balanced braces. Anything
// subtler (a bad min-chars, an unknown key, an impossible charset budget) is
// left to Vault.

export type PasswordHclReason = 'empty' | 'unbalanced_braces' | 'missing_length' | 'missing_charset_rule'

/** The top-level `length = <int>` assignment every password policy must declare. */
const LENGTH_PATTERN = /(^|[\s{])length\s*=/

/** A `rule "charset" {` stanza — a policy needs at least one to have a charset budget. */
const CHARSET_RULE_PATTERN = /rule\s+"charset"\s*\{/

/** Run the basic HCL checks; returns `{ ok: true }` or the first failure reason. */
export function checkPasswordPolicyHcl(policy: string): { ok: true } | { ok: false; reason: PasswordHclReason } {
  const trimmed = policy.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }

  // Braces must be balanced and never dip below zero (a stray `}` before its `{`).
  // This is a light count, not a parser: a brace inside a quoted charset string is
  // counted too, which is acceptable — Vault is the real validator on write.
  let depth = 0
  for (const ch of trimmed) {
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth < 0) return { ok: false, reason: 'unbalanced_braces' }
    }
  }
  if (depth !== 0) return { ok: false, reason: 'unbalanced_braces' }

  if (!LENGTH_PATTERN.test(trimmed)) return { ok: false, reason: 'missing_length' }
  if (!CHARSET_RULE_PATTERN.test(trimmed)) return { ok: false, reason: 'missing_charset_rule' }

  return { ok: true }
}

/**
 * Canonicalize a password-policy HCL body for drift comparison: collapse every
 * run of whitespace/newlines to one space and trim. Vault stores what you send,
 * but a policy edited out-of-band may be reformatted, so a raw string compare
 * would read cosmetic reflow as drift. Both the deployed and the live body pass
 * through this before comparing.
 *
 * Comments are deliberately NOT stripped: unlike an ACL policy, a password
 * policy `charset` string can legitimately contain a `#` (it is a valid password
 * character), so stripping `#`-to-end-of-line comments would corrupt the charset
 * asymmetrically. Whitespace-only normalization is symmetric and deterministic.
 */
export function normalizePasswordPolicy(policy: string): string {
  return policy.replace(/\s+/g, ' ').trim()
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface PasswordPolicySpec {
  sectionName: string
  /** Policy name — the logical identity, used verbatim as Vault stores it. */
  name: string
  /** Raw HCL policy body — sent verbatim to Vault. */
  policy: string
}

/** Shape of a password policy returned by GET /sys/policies/password/{name} (`{ data: … }`). */
export interface LivePasswordPolicy {
  policy?: string
}

/** Each canvas item describes one Vault password generation policy. */
export function extractPasswordPolicySpecs(canvas: CanvasSnapshot): PasswordPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    const policy = typeof fields.policy === 'string' ? fields.policy.trim() : ''
    return { sectionName: section.name, name, policy }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate password generation policy configurations statically (no network):
 * a name is required (matching `[A-Za-z0-9_-]+`), the HCL body is required and
 * passes the basic structural checks (has a `length =`, has at least one
 * `rule "charset"` block, balanced braces), and each name — a policy's logical
 * identity — is unique within the canvas.
 *
 * There is no documented set of reserved/built-in password policy names, so —
 * unlike ACL policies — no name is treated as protected.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPasswordPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, `[A-Za-z0-9_-]+`, unique in the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Password policy name is required', code: 'required' })
    } else {
      if (!PASSWORD_POLICY_NAME_PATTERN.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Password policy name may only contain letters, numbers, underscores and hyphens',
          code: 'invalid_name',
        })
      }

      // The name is the policy's logical identity — dedupe on it (used verbatim,
      // so the dedup key equals the upsert path in deploy).
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate password policy "${spec.name}" — each policy name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(spec.name)
    }

    // policy — required HCL body, passing the basic structural checks
    if (!spec.policy) {
      errors.push({ field: `${prefix}.policy`, message: 'Password policy HCL is required', code: 'required' })
    } else {
      const hcl = checkPasswordPolicyHcl(spec.policy)
      if (!hcl.ok) {
        if (hcl.reason === 'unbalanced_braces') {
          errors.push({
            field: `${prefix}.policy`,
            message: 'Password policy HCL has unbalanced braces — every "{" needs a matching "}"',
            code: 'unbalanced_braces',
          })
        } else if (hcl.reason === 'missing_length') {
          errors.push({
            field: `${prefix}.policy`,
            message: 'Password policy HCL must declare a total length, e.g. length = 20',
            code: 'missing_length',
          })
        } else if (hcl.reason === 'missing_charset_rule') {
          errors.push({
            field: `${prefix}.policy`,
            message:
              'Password policy HCL must contain at least one charset rule, e.g. rule "charset" { charset = "abc…" min-chars = 1 }',
            code: 'missing_charset_rule',
          })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
