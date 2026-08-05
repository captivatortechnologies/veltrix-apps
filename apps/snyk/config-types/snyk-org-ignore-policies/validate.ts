import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { readSnykSettings } from '../../lib/snyk'

// =============================================================================
// Snyk org-level ignore policies — REST API
// (GET/POST /orgs/{org_id}/policies, PATCH/DELETE /orgs/{org_id}/policies/{policy_id}).
//
// IMPORTANT SCOPE NOTE (verified against Snyk's OpenAPI spec): this API is
// documented as "only available for use with Code Consistent Ignores" — it is
// NOT a general security/license policy engine. Its condition field is fixed
// to `snyk/asset/finding/v1` (a Snyk Code finding identity, e.g. the issues
// API's `key_asset` or a CLI SARIF fingerprint) with operator `includes`; the
// action is always an ignore classification identical to the project-level
// ignore reasons (config-types/snyk-project-ignores): not-vulnerable,
// wont-fix, temporary-ignore. Writing a policy requires Code Consistent
// Ignores enabled for the org (Snyk returns 403 otherwise — surfaced as-is by
// deploy, not special-cased here).
//
// VERSION NOTE: Snyk's 2024-10-15 revision of this endpoint is marked
// deprecated-by 2026-03-25 with a 2026-09-22 sunset; the request/response shape
// is IDENTICAL between the two revisions (verified), so this works today
// regardless of the org's configured `api_version` app setting — but validate()
// warns when that setting is still on/before 2024-10-15 so it gets bumped
// before the sunset date.
//
// Identity is the policy NAME (Snyk assigns the policy id on create, so
// reconciliation matches by name — same convention as snyk-service-accounts).
// =============================================================================

export const POLICY_IGNORE_TYPES = ['not-vulnerable', 'wont-fix', 'temporary-ignore'] as const
export type PolicyIgnoreType = (typeof POLICY_IGNORE_TYPES)[number]

/** The Snyk API revision the deprecated (soon-sunsetting) policies shape is tied to. */
const POLICIES_API_SUNSET_VERSION = '2026-03-25'

export interface PolicySpec {
  sectionName: string
  name: string
  findingKey: string
  ignoreType: string
  reason: string
  expires: string
}

/** The live policy resource, as returned by GET /orgs/{org_id}/policies. */
export interface LivePolicy {
  id?: string
  type?: string
  attributes?: {
    name?: string
    action_type?: string
    action?: { data?: { ignore_type?: string; reason?: string; expires?: string } }
    conditions_group?: {
      logical_operator?: string
      conditions?: Array<{ field?: string; operator?: string; value?: string }>
    }
    review?: string
    created_at?: string
    updated_at?: string
  }
}

/** The policy name is a policy's logical identity (Snyk generates the policy id). */
export function policyKey(name: string): string {
  return name.trim().toLowerCase()
}

/** The `conditions_group` Snyk expects — a single `snyk/asset/finding/v1` / `includes` condition. */
export function buildConditionsGroup(findingKey: string): {
  logical_operator: 'and'
  conditions: Array<{ field: 'snyk/asset/finding/v1'; operator: 'includes'; value: string }>
} {
  return {
    logical_operator: 'and',
    conditions: [{ field: 'snyk/asset/finding/v1', operator: 'includes', value: findingKey }],
  }
}

/** The `action` Snyk expects — an ignore classification, reason and (for temporary-ignore) an expiry. */
export function buildIgnoreAction(spec: { ignoreType: string; reason: string; expires: string }): {
  data: Record<string, unknown>
} {
  const data: Record<string, unknown> = { ignore_type: spec.ignoreType }
  if (spec.reason) data.reason = spec.reason
  if (spec.expires) data.expires = spec.expires
  return { data }
}

/** Each canvas item describes one org-level ignore policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      findingKey: typeof fields.finding_key === 'string' ? fields.finding_key.trim() : '',
      ignoreType:
        typeof fields.ignore_type === 'string' && fields.ignore_type.trim() ? fields.ignore_type.trim() : 'not-vulnerable',
      reason: typeof fields.reason === 'string' ? fields.reason.trim() : '',
      expires: typeof fields.expires === 'string' ? fields.expires.trim() : '',
    }
  })
}

/**
 * Validate org-level ignore policies: a name and finding-match value are
 * required, the ignore type is from the supported set, a temporary ignore
 * requires an expiry, and each policy name is unique across the canvas. Warns
 * when the org's configured REST API version is on/before the revision Snyk
 * has marked for sunset.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no ignore-policy items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicySpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    }
    if (!spec.findingKey) {
      errors.push({ field: `${prefix}.finding_key`, message: 'A finding-match value is required', code: 'required' })
    }
    if (!POLICY_IGNORE_TYPES.includes(spec.ignoreType as PolicyIgnoreType)) {
      errors.push({
        field: `${prefix}.ignore_type`,
        message: `Unsupported ignore type "${spec.ignoreType}"`,
        code: 'invalid_ignore_type',
      })
    }
    if (spec.ignoreType === 'temporary-ignore' && !spec.expires) {
      errors.push({
        field: `${prefix}.expires`,
        message: 'A temporary ignore requires an expiry date',
        code: 'required_expires',
      })
    }

    if (spec.name) {
      const key = policyKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" — each policy name may only be declared once`,
          code: 'duplicate_policy',
        })
      }
      seen.add(key)
    }
  }

  const configuredVersion = readSnykSettings(ctx.settings).apiVersion
  if (configuredVersion < POLICIES_API_SUNSET_VERSION) {
    warnings.push({
      field: 'api_version',
      message: `The org-level policies API at REST version "${configuredVersion}" is deprecated and sunsets 2026-09-22 — bump the "REST API Version" app setting to "${POLICIES_API_SUNSET_VERSION}" or later before then`,
      code: 'policies_api_version_sunsetting',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
