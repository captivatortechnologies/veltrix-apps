import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Non-Employee Source constraints ---------------------------
// Manages the non-employee source CONTAINER only. Individual non-employee records
// are per-end-user and out of scope.

export const MAX_NAME_LENGTH = 128
export const MAX_APPROVERS = 3
export const MAX_ACCOUNT_MANAGERS = 10

export interface NonEmployeeSourceSpec {
  itemId?: string
  name: string
  description: string
  ownerId: string
  managementWorkgroup: string
  approvers: string[]
  accountManagers: string[]
}

/** A non-employee source as returned by GET /beta/non-employee-sources. */
export interface LiveNonEmployeeSource {
  id?: string
  name?: string
  description?: string | null
  owner?: { id?: string }
  managementWorkgroup?: string | null
  approvers?: Array<{ id?: string }>
  accountManagers?: Array<{ id?: string }>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function toIdList(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v.map((x) => String(x).trim())
    : typeof v === 'string'
      ? v.split(/[,\n]/).map((s) => s.trim())
      : []
  return [...new Set(raw.filter((s) => s.length > 0))]
}

export function extractNonEmployeeSourceSpecs(canvas: CanvasSnapshot): NonEmployeeSourceSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      ownerId: asString(f.ownerId),
      managementWorkgroup: asString(f.managementWorkgroup),
      approvers: toIdList(f.approvers),
      accountManagers: toIdList(f.accountManagers),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractNonEmployeeSourceSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate non-employee source "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'A description is required', code: 'required' })
    }
    if (!spec.ownerId) {
      errors.push({ field: `${prefix}.ownerId`, message: 'An owner id is required', code: 'required' })
    }
    if (spec.approvers.length > MAX_APPROVERS) {
      errors.push({ field: `${prefix}.approvers`, message: `At most ${MAX_APPROVERS} approvers are allowed`, code: 'too_many' })
    }
    if (spec.accountManagers.length > MAX_ACCOUNT_MANAGERS) {
      errors.push({ field: `${prefix}.accountManagers`, message: `At most ${MAX_ACCOUNT_MANAGERS} account managers are allowed`, code: 'too_many' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
