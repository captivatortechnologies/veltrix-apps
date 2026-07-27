import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Password Sync Group constraints ---------------------------

export const MAX_NAME_LENGTH = 128

export interface PasswordSyncGroupSpec {
  itemId?: string
  name: string
  /** id of the password policy that governs the group. */
  passwordPolicyId: string
  /** ids of the sources whose passwords are kept in sync. */
  sourceIds: string[]
}

/** A password sync group as returned by GET /v3/password-sync-groups. */
export interface LivePasswordSyncGroup {
  id?: string
  name?: string
  passwordPolicyId?: string
  sourceIds?: string[]
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

export function extractPasswordSyncGroupSpecs(canvas: CanvasSnapshot): PasswordSyncGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      passwordPolicyId: asString(f.passwordPolicyId),
      sourceIds: toIdList(f.sourceIds),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPasswordSyncGroupSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate password sync group "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.passwordPolicyId) {
      errors.push({ field: `${prefix}.passwordPolicyId`, message: 'A password policy id is required', code: 'required' })
    }
    if (spec.name && spec.sourceIds.length === 0) {
      warnings.push({ field: `${prefix}.sourceIds`, message: `Password sync group "${spec.name}" has no sources — it syncs nothing`, code: 'no_sources' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
