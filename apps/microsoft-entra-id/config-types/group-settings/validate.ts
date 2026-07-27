import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra group (directory) settings constraints ----------------------------

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export interface GroupSettingValue {
  name: string
  value: string
}

export interface GroupSettingSpec {
  itemId?: string
  /** templateId — the identity (one settings object per groupSettingTemplate). */
  templateId: string
  /** Raw JSON text: an array of { name, value } pairs matching the template. */
  values: string
}

/** A group (directory) setting as returned by Graph. */
export interface LiveGroupSetting {
  id?: string
  templateId?: string
  displayName?: string
  values?: GroupSettingValue[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse a JSON string into an array, or null when it isn't a JSON array. */
export function parseValues(text: string): GroupSettingValue[] | null {
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return null
    return parsed as GroupSettingValue[]
  } catch {
    return null
  }
}

/** Order-insensitive canonical form of a values collection (by name → value). */
export function canonicalValues(values: GroupSettingValue[] | undefined): string {
  const map: Record<string, unknown> = {}
  for (const v of values ?? []) {
    if (v && typeof v === 'object' && typeof v.name === 'string') map[v.name] = v.value
  }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(map).sort()) out[k] = map[k]
  return JSON.stringify(out)
}

export function extractGroupSettingSpecs(canvas: CanvasSnapshot): GroupSettingSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      templateId: asString(f.templateId).toLowerCase(),
      values: asString(f.values),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractGroupSettingSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.templateId) {
      errors.push({ field: `${prefix}.templateId`, message: 'Template ID is required', code: 'required' })
    } else {
      if (!GUID_RE.test(spec.templateId)) {
        errors.push({
          field: `${prefix}.templateId`,
          message: `Template ID "${spec.templateId}" must be a GUID (a groupSettingTemplate id)`,
          code: 'invalid_template_id',
        })
      }
      if (seen.has(spec.templateId)) {
        errors.push({
          field: `${prefix}.templateId`,
          message: `Duplicate template "${spec.templateId}" — each may only be declared once per canvas`,
          code: 'duplicate_template_id',
        })
      }
      seen.add(spec.templateId)
    }

    const values = parseValues(spec.values)
    if (values === null) {
      errors.push({
        field: `${prefix}.values`,
        message: 'Values must be a valid JSON array of { name, value } pairs',
        code: 'invalid_json',
      })
    } else {
      values.forEach((v, vi) => {
        if (!v || typeof v !== 'object' || typeof v.name !== 'string' || v.name.trim() === '') {
          errors.push({
            field: `${prefix}.values[${vi}]`,
            message: 'Each value must be an object with a non-empty "name" and a "value"',
            code: 'invalid_value',
          })
        }
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
