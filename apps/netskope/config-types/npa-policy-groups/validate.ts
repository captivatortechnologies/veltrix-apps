import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope NPA policy group constraints -----------------------------------

export const MAX_NAME_LENGTH = 255

export interface PolicyGroupSpec {
  itemId?: string
  /** group_name — the logical identity (groups are id-addressed with no name
   *  filter; the app matches on name and stores the id for rename-safety). */
  name: string
}

/** A policy group as returned by GET /api/v2/policy/npa/policygroups
 *  (list under the NPA {data} envelope). */
export interface LivePolicyGroup {
  id?: number | string
  group_name?: string
  /** Built-in groups return can_be_edited_deleted=false and must be preserved. */
  can_be_edited_deleted?: boolean | string
  group_type?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Whether a live group is a preserved built-in (never modified or deleted). */
export function isBuiltInGroup(l: LivePolicyGroup): boolean {
  return l.can_be_edited_deleted === false || l.can_be_edited_deleted === 'false'
}

export function extractPolicyGroupSpecs(canvas: CanvasSnapshot): PolicyGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.group_name) || item.name,
  }))
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPolicyGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.group_name`, message: 'Group name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.group_name`, message: `Group name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.group_name`, message: `Duplicate policy group "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
