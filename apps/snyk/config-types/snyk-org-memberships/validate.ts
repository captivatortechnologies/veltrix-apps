import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Snyk org memberships — grant/change/revoke an EXISTING Snyk user's role in
// this org, via the REST API
// (GET/POST /orgs/{org_id}/memberships, PATCH/DELETE /orgs/{org_id}/memberships/{membership_id},
// GA since 2024-08-25).
//
// Identity is the target user's Snyk user id (a UUID) — `POST` requires it and
// there is no email-based create; a brand-new external user must first be
// invited into the org (a one-shot, non-declarative action — out of scope, see
// README). `email` is carried as an OPTIONAL, purely informational label: it is
// never sent to Snyk and never used for matching. This config type only
// manages memberships it DECLARES — it never removes a membership that is not
// declared here (so an operator can never be locked out of their own org by a
// deploy of this config type).
// =============================================================================

export interface MembershipSpec {
  sectionName: string
  userId: string
  email: string
  roleId: string
}

/** The live org-membership resource, as returned by GET /orgs/{org_id}/memberships. */
export interface LiveMembership {
  id?: string
  type?: string
  attributes?: { created_at?: string }
  relationships?: {
    user?: { data?: { id?: string; attributes?: { email?: string; name?: string; username?: string } } }
    role?: { data?: { id?: string; attributes?: { name?: string } } }
  }
}

/** The user id is a membership's logical identity (case-insensitive UUID compare). */
export function membershipKey(userId: string): string {
  return userId.trim().toLowerCase()
}

/** Each canvas item describes one user's membership + role in this org. */
export function extractMembershipSpecs(canvas: CanvasSnapshot): MembershipSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      userId: typeof fields.user_id === 'string' ? fields.user_id.trim() : '',
      email: typeof fields.email === 'string' ? fields.email.trim() : '',
      roleId: typeof fields.role_id === 'string' ? fields.role_id.trim() : '',
    }
  })
}

/**
 * Validate membership configurations: a Snyk user id and org role id are
 * required, and each user id is unique across the canvas (one membership per
 * user).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no membership items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractMembershipSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.userId) {
      errors.push({ field: `${prefix}.user_id`, message: 'Snyk user id is required', code: 'required' })
    }
    if (!spec.roleId) {
      errors.push({ field: `${prefix}.role_id`, message: 'A Snyk org role id is required', code: 'required' })
    }

    if (spec.userId) {
      const key = membershipKey(spec.userId)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.user_id`,
          message: `Duplicate membership for user "${spec.userId}" — each user may only be declared once`,
          code: 'duplicate_membership',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
