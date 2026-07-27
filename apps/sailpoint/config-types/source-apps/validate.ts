import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Source App (access-request application) constraints --------

export const MAX_NAME_LENGTH = 128

export interface SourceAppSpec {
  itemId?: string
  name: string
  description: string
  /** id of the source that provides this app's accounts (immutable). */
  accountSourceId: string
  matchAllAccounts: boolean
}

/** A source app as returned by GET /beta/source-apps. */
export interface LiveSourceApp {
  id?: string
  name?: string
  description?: string | null
  accountSource?: { id?: string }
  matchAllAccounts?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractSourceAppSpecs(canvas: CanvasSnapshot): SourceAppSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      accountSourceId: asString(f.accountSourceId),
      matchAllAccounts: asBool(f.matchAllAccounts),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractSourceAppSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate source app "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.accountSourceId) {
      errors.push({ field: `${prefix}.accountSourceId`, message: 'An account source id is required', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
