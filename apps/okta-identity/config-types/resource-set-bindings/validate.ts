import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Resource Set Bindings API constraints ------------------------------
//
// A binding GRANTS a role (a custom admin role, or a standard role type) to a set
// of members (users/groups) WITHIN a resource set. It is the piece that ties the
// `custom-admin-roles` + `resource-sets` types together into a working grant.
//
// A binding's logical identity is the (resourceSet, role) PAIR — the same role can
// be bound in many resource sets and a resource set can hold many role bindings,
// so neither key alone identifies the binding. Endpoints (all under
// /api/v1/iam/resource-sets/{resourceSetIdOrLabel}/bindings):
//   GET    /bindings                          — list ({ roles: [{ id, _links }] })
//   GET    /bindings/{roleIdOrLabel}          — retrieve one (404 = absent)
//   POST   /bindings                          — create ({ role, members: [url] })
//   DELETE /bindings/{roleIdOrLabel}          — delete the whole binding
//   GET    /bindings/{roleIdOrLabel}/members             — list members
//   PATCH  /bindings/{roleIdOrLabel}/members             — add ({ additions: [url] })
//   DELETE /bindings/{roleIdOrLabel}/members/{memberId}  — remove one member
//
// Members are URLs to Okta user/group instances (or ORNs). A live member exposes
// its principal at `_links.self.href` (there is no separate list — it IS the
// user/group URL) and its membership id at `id` (the DELETE key). Okta deletes a
// binding when its LAST member is removed, so a binding always has >= 1 member;
// reconciliation ADDS before it REMOVES so the member count never transiently
// hits zero.

/**
 * Plausible member reference: an Okta user/group REST URL or an ORN. Used only for
 * a soft WARNING — Okta owns the authoritative principal model and rejects an
 * invalid member reference at deploy time.
 */
export const MEMBER_REFERENCE_PATTERN = /^(orn:okta:[a-z0-9-]+:.+|https:\/\/.+\/(users|groups)\/.+)$/

/** Okta caps a binding at 5000 members; keep a generous ceiling for validation. */
export const MAX_MEMBERS_PER_BINDING = 5000

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface BindingSpec {
  sectionName: string
  /** Resource set id or label — half of the (resourceSet, role) identity. */
  resourceSet: string
  /** Role id (custom `cr0...`) or standard role type — the other half of identity. */
  role: string
  /** De-duplicated member references (user/group REST URLs or ORNs). */
  members: string[]
}

/** Shape of a binding returned by GET .../bindings/{role} (ResourceSetBindingResponse). */
export interface LiveBinding {
  id?: string
  _links?: unknown
  [key: string]: unknown
}

/**
 * Shape of a binding member returned by GET .../bindings/{role}/members. `id` is
 * the MEMBERSHIP object's id (the value passed to DELETE .../members/{id}), NOT the
 * principal's id. The principal (user/group) URL is under `_links.self.href`; some
 * responses may also carry a normalized `orn`.
 */
export interface LiveBindingMember {
  /** Membership object id — the DELETE key. */
  id?: string
  /** Normalized ORN of the principal, when present. */
  orn?: string
  _links?: { self?: { href?: string } }
  [key: string]: unknown
}

/** Split a canvas `tags` value (array) or comma/newline string into trimmed items. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Each canvas item describes one (resourceSet, role) binding. */
export function extractBindingSpecs(canvas: CanvasSnapshot): BindingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      resourceSet: typeof fields.resourceSet === 'string' ? fields.resourceSet.trim() : '',
      role: typeof fields.role === 'string' ? fields.role.trim() : '',
      // De-dupe the member set so reconciliation math is stable.
      members: [...new Set(splitList(fields.members))],
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate resource-set-binding configurations against the Okta Roles API. Static
 * only — it never contacts Okta:
 *   - resourceSet is required (the resource set id or label the grant is scoped to)
 *   - role is required (a custom role id `cr0...` or a standard role type);
 *     a value with spaces is flagged (WARNING) as it looks like a label, not a key
 *   - at least one member is required, at most 5000; each is flagged (WARNING) if
 *     it does not look like a user/group REST URL or an ORN
 *   - the (resourceSet, role) PAIR — the binding's identity — is unique per canvas
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractBindingSpecs(ctx.canvas)
  const seenPairs = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // resourceSet — required (the resource set the grant is scoped to)
    if (!spec.resourceSet) {
      errors.push({
        field: `${prefix}.resourceSet`,
        message: 'Resource set id or label is required — the resource set this grant is scoped to',
        code: 'required',
      })
    }

    // role — required; a custom role id (cr0...) or a standard role type
    if (!spec.role) {
      errors.push({
        field: `${prefix}.role`,
        message:
          'Role is required — the id of a custom admin role (e.g. cr0...) or a standard role type (e.g. HELP_DESK_ADMIN)',
        code: 'required',
      })
    } else if (/\s/.test(spec.role)) {
      warnings.push({
        field: `${prefix}.role`,
        message: `"${spec.role}" contains spaces — the binding role must be the role's id (cr0...) or a standard role type, not a display label. Okta may reject a label at create time.`,
        code: 'role_looks_like_label',
      })
    }

    // members — at least one, at most 5000; each flagged (warning) if shape looks off
    if (spec.members.length === 0) {
      errors.push({
        field: `${prefix}.members`,
        message:
          'Add at least one member (an Okta user/group REST URL or ORN), e.g. https://your-org.okta.com/api/v1/groups/00g...',
        code: 'required',
      })
    } else {
      if (spec.members.length > MAX_MEMBERS_PER_BINDING) {
        errors.push({
          field: `${prefix}.members`,
          message: `A binding may contain at most ${MAX_MEMBERS_PER_BINDING} members`,
          code: 'too_many_members',
        })
      }
      for (const ref of spec.members) {
        if (!MEMBER_REFERENCE_PATTERN.test(ref)) {
          warnings.push({
            field: `${prefix}.members`,
            message: `"${ref}" does not look like an Okta user/group REST URL or an ORN — Okta will reject an invalid member reference at deploy time`,
            code: 'suspicious_member',
          })
        }
      }
    }

    // (resourceSet, role) PAIR is the binding's logical identity — dedupe on it.
    if (spec.resourceSet && spec.role) {
      const key = JSON.stringify([spec.resourceSet, spec.role])
      if (seenPairs.has(key)) {
        errors.push({
          field: `${prefix}.role`,
          message: `Duplicate binding of role "${spec.role}" in resource set "${spec.resourceSet}" — each (resourceSet, role) pair may only be declared once per canvas`,
          code: 'duplicate_binding',
        })
      }
      seenPairs.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
