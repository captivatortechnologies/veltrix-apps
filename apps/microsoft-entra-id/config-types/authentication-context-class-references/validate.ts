import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra authentication-context constraints --------------------------------

export const MAX_DISPLAY_NAME_LENGTH = 256
export const MAX_DESCRIPTION_LENGTH = 1024
/** The id must be one of the reserved values c1 through c25. */
const CONTEXT_ID_RE = /^c([1-9]|1[0-9]|2[0-5])$/

export interface AuthContextSpec {
  itemId?: string
  /** The authentication context id (c1..c25) — the logical identity and acrs claim value. */
  contextId: string
  displayName: string
  description: string
  isAvailable: boolean
}

/** An authentication context class reference as returned by Graph. */
export interface LiveAuthContext {
  id?: string
  displayName?: string
  description?: string | null
  isAvailable?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractAuthContextSpecs(canvas: CanvasSnapshot): AuthContextSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      contextId: asString(f.contextId).toLowerCase(),
      displayName: asString(f.displayName) || item.name,
      description: asString(f.description),
      isAvailable: asBool(f.isAvailable),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAuthContextSpecs(ctx.canvas)
  const seenIds = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    // contextId — required, c1..c25, uniqueness
    if (!spec.contextId) {
      errors.push({ field: `${prefix}.contextId`, message: 'Context id is required', code: 'required' })
    } else {
      if (!CONTEXT_ID_RE.test(spec.contextId)) {
        errors.push({
          field: `${prefix}.contextId`,
          message: `Context id "${spec.contextId}" must be one of c1 through c25`,
          code: 'invalid_context_id',
        })
      }
      if (seenIds.has(spec.contextId)) {
        errors.push({
          field: `${prefix}.contextId`,
          message: `Duplicate context id "${spec.contextId}" — each may only be declared once per canvas`,
          code: 'duplicate_context_id',
        })
      }
      seenIds.add(spec.contextId)
    }

    // displayName — required, length
    if (!spec.displayName) {
      errors.push({ field: `${prefix}.displayName`, message: 'Display name is required', code: 'required' })
    } else if (spec.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.displayName`,
        message: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
        code: 'too_long',
      })
    }

    // description — length only
    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'too_long',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
