import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra application-management-policy constraints -------------------------

export const MAX_DISPLAY_NAME_LENGTH = 256

export interface AppManagementSpec {
  itemId?: string
  /** displayName — the logical identity live policies are matched on. */
  name: string
  description: string
  isEnabled: boolean
  /** Raw JSON text for the restrictions (appManagementConfiguration) object. */
  restrictions: string
}

/** An application management policy as returned by Graph. */
export interface LiveAppManagementPolicy {
  id?: string
  displayName?: string
  description?: string | null
  isEnabled?: boolean
  restrictions?: Record<string, unknown> | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Parse a JSON string into a plain object, or null when it isn't a JSON object. */
export function parseObject(text: string): Record<string, unknown> | null {
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

export function canonical(v: unknown): string {
  return JSON.stringify(sortValue(v ?? {}))
}

export function extractAppManagementSpecs(canvas: CanvasSnapshot): AppManagementSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      isEnabled: asBool(f.isEnabled),
      restrictions: asString(f.restrictions),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAppManagementSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate app management policy "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (spec.restrictions && !parseObject(spec.restrictions)) {
      errors.push({
        field: `${prefix}.restrictions`,
        message: 'Restrictions must be a valid JSON object',
        code: 'invalid_json',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
