import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- 1Password SCIM Bridge Groups constraints ---------------------------------
// Standard SCIM 2.0 (RFC 7643 core Group schema / RFC 7644 protocol):
//
// GET     /Groups            - list (ListResponse envelope)
// POST    /Groups            - create
// GET     /Groups/{id}       - read
// PATCH   /Groups/{id}       - partial update (PatchOp) - used here to
//                              full-replace the `members` multi-valued
//                              attribute, 1Password's documented "manage
//                              access to groups" capability
//
// A group's logical identity in this config type is its SCIM `displayName` -
// the bridge has no upsert, so this app matches an existing group by
// displayName, the same convention used by every other name-keyed config
// type across this codebase.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Turn a remote-multiselect value (array of option values) into a clean, de-duped string list. */
export function toEmailList(value: unknown): string[] {
  let items: string[]
  if (Array.isArray(value)) {
    items = value.map((v) => String(v).trim())
  } else if (typeof value === 'string') {
    items = value.split(/[,\n]/).map((v) => v.trim())
  } else {
    return []
  }
  return [...new Set(items.filter((v) => v.length > 0))]
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface GroupSpec {
  sectionName: string
  /** SCIM displayName - this item's identity. */
  displayName: string
  /** Declared members by email (SCIM userName) - a FULL REPLACE set. */
  memberUserNames: string[]
}

/** Shape of a SCIM Group resource, as returned by GET /Groups and GET /Groups/{id}. */
export interface LiveGroup {
  id?: string
  displayName?: string
  members?: Array<{ value?: string; display?: string; $ref?: string }>
  [key: string]: unknown
}

/** Each canvas item describes one 1Password custom Group. */
export function extractGroupSpecs(canvas: CanvasSnapshot): GroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      displayName: typeof fields.displayName === 'string' ? fields.displayName.trim() : '',
      memberUserNames: toEmailList(fields.memberUserNames),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate group configurations against the SCIM Groups model. Static only -
 * it never contacts the SCIM Bridge (member emails are resolved to live user
 * ids in deploy.ts, which can fail the deploy clearly if one doesn't exist):
 *   - displayName is required and unique across the canvas
 *   - every declared member value looks like an email address, in case a
 *     value was hand-edited via the canvas JSON rather than picked from the
 *     live options list
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.displayName`, message: 'Group name is required', code: 'required' })
    } else {
      const key = spec.displayName.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.displayName`,
          message: `Duplicate group "${spec.displayName}" - each group may only be declared once per canvas`,
          code: 'duplicate_group',
        })
      }
      seenNames.add(key)
    }

    const invalid = spec.memberUserNames.filter((email) => !EMAIL_PATTERN.test(email))
    if (invalid.length > 0) {
      errors.push({
        field: `${prefix}.memberUserNames`,
        message: `Members must be valid email addresses (got: ${invalid.join(', ')})`,
        code: 'invalid_member_email',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
