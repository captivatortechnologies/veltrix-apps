import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault ACL policy constraints ---------------------------------------------

/**
 * A policy name is `[A-Za-z0-9_-]+`. Vault lowercases policy names on submission
 * ("policy names are case-insensitive"), so the app treats the lowercased name
 * as the object's identity everywhere.
 */
export const POLICY_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * `root` is fully reserved — it cannot be created, updated or deleted, so the
 * canvas refuses it outright. `default` is attached to every token; it MAY be
 * updated but must NEVER be deleted, so the canvas warns and deploy/rollback
 * never issue a DELETE for it.
 */
export const RESERVED_POLICY_NAME = 'root'
export const DEFAULT_POLICY_NAME = 'default'

/** True when `name` (case-insensitively) is the reserved root policy. */
export function isRootPolicy(name: string): boolean {
  return name.trim().toLowerCase() === RESERVED_POLICY_NAME
}

/** True when `name` (case-insensitively) is the built-in default policy. */
export function isDefaultPolicy(name: string): boolean {
  return name.trim().toLowerCase() === DEFAULT_POLICY_NAME
}

// --- Basic client-side HCL sanity check ---------------------------------------
//
// There is NO server-side dry-run for a policy; the real gate is Vault's 400 on
// write. This is a light structural check — NOT an HCL parser: the body must be
// non-empty, have balanced braces, and contain at least one `path "…" { … }`
// block. Anything subtler is left to Vault.

export type HclReason = 'empty' | 'unbalanced_braces' | 'missing_path_block'

/** A single `path "…" {` stanza — the minimum a usable ACL policy needs. */
const PATH_BLOCK_PATTERN = /path\s+"[^"]+"\s*\{/

/** Run the basic HCL checks; returns `{ ok: true }` or the first failure reason. */
export function checkPolicyHcl(policy: string): { ok: true } | { ok: false; reason: HclReason } {
  const trimmed = policy.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }

  // Braces must be balanced and never dip below zero (a stray `}` before its `{`).
  let depth = 0
  for (const ch of trimmed) {
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth < 0) return { ok: false, reason: 'unbalanced_braces' }
    }
  }
  if (depth !== 0) return { ok: false, reason: 'unbalanced_braces' }

  if (!PATH_BLOCK_PATTERN.test(trimmed)) return { ok: false, reason: 'missing_path_block' }

  return { ok: true }
}

/**
 * Canonicalize an HCL policy body for drift comparison: strip `#` and `//` line
 * comments and collapse all whitespace. Vault stores what you send, but a policy
 * edited out-of-band may be reformatted, so raw string compare = false drift.
 * Both the deployed and the live body pass through this before comparing.
 *
 * Only line comments are stripped (to end of line) — this is symmetric and
 * deterministic. Block comments are deliberately NOT stripped: Vault glob paths
 * such as a "secret/star" pattern contain a slash-star sequence, and a
 * length-dependent block strip would corrupt them asymmetrically. Because both
 * sides normalize identically, an unchanged policy still compares equal.
 */
export function normalizePolicy(policy: string): string {
  return policy
    .replace(/(#|\/\/)[^\r\n]*/g, ' ') // # and // line comments (to end of line)
    .replace(/\s+/g, ' ') // collapse every run of whitespace/newlines to one space
    .trim()
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface PolicySpec {
  sectionName: string
  /** Policy name — the logical identity, lowercased to match how Vault stores it. */
  name: string
  /** Raw HCL policy body — sent verbatim to Vault. */
  policy: string
}

/** Shape of a policy returned by GET /sys/policies/acl/{name} (`{ data: … }`). */
export interface LivePolicy {
  name?: string
  policy?: string
}

/** Each canvas item describes one Vault ACL policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    // Vault lowercases policy names — canonicalize so the identity is stable and
    // "Foo"/"foo" are recognized as the same policy across create-vs-update.
    const name = typeof fields.name === 'string' ? fields.name.trim().toLowerCase() : ''
    const policy = typeof fields.policy === 'string' ? fields.policy.trim() : ''
    return { sectionName: section.name, name, policy }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate ACL policy configurations statically (no network):
 * a name is required (matching `[A-Za-z0-9_-]+`, not the reserved `root`), the
 * HCL body is required and passes basic structural checks, and each name — a
 * policy's logical identity — is unique within the canvas. `default` is allowed
 * but warned about (it applies to every token).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, `[A-Za-z0-9_-]+`, not root, unique in the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else {
      if (isRootPolicy(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Policy name "root" is reserved — the root policy cannot be created, updated or deleted',
          code: 'reserved_name',
        })
      } else if (!POLICY_NAME_PATTERN.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Policy name may only contain letters, numbers, underscores and hyphens',
          code: 'invalid_name',
        })
      }

      // default may be managed but is attached to every token — warn, never block.
      if (isDefaultPolicy(spec.name)) {
        warnings.push({
          field: `${prefix}.name`,
          message:
            'The "default" policy is attached to every token — updating it affects all authentication. It will be updated (never deleted) on rollback.',
          code: 'default_policy',
        })
      }

      // The name is the policy's logical identity — dedupe on it (case already
      // folded on extraction, matching Vault's case-insensitive names).
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" — each policy name may only be declared once per canvas`,
          code: 'duplicate_policy',
        })
      }
      seenNames.add(spec.name)
    }

    // policy — required HCL body, passing the basic structural checks
    if (!spec.policy) {
      errors.push({ field: `${prefix}.policy`, message: 'Policy HCL is required', code: 'required' })
    } else {
      const hcl = checkPolicyHcl(spec.policy)
      if (!hcl.ok) {
        if (hcl.reason === 'unbalanced_braces') {
          errors.push({
            field: `${prefix}.policy`,
            message: 'Policy HCL has unbalanced braces — every "{" needs a matching "}"',
            code: 'unbalanced_braces',
          })
        } else if (hcl.reason === 'missing_path_block') {
          errors.push({
            field: `${prefix}.policy`,
            message:
              'Policy HCL must contain at least one path block, e.g. path "secret/data/*" { capabilities = ["read"] }',
            code: 'missing_path_block',
          })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
