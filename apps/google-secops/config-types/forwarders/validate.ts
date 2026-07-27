import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps forwarder constraints -------------------------------------

export interface ForwarderSpec {
  itemId?: string
  /** displayName = the forwarder's identity we own (the id is a server UUID). */
  displayName: string
  configRaw: string
  /** Parsed `config` object, or null when the JSON is malformed. */
  config: Record<string, unknown> | null
}

/** A forwarder as returned by the SecOps API. `name` is `{parent}/forwarders/{id}`. */
export interface LiveForwarder {
  name?: string
  displayName?: string
  config?: {
    uploadCompression?: boolean
    metadata?: { assetNamespace?: string; labels?: Record<string, string> }
    [k: string]: unknown
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse the `config` JSON blob into an object, or null when it is not a JSON object. */
export function parseConfig(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function extractForwarderSpecs(canvas: CanvasSnapshot): ForwarderSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const configRaw = asString(f.config)
    return {
      itemId: item.id,
      displayName: asString(f.displayName) || item.name,
      configRaw,
      config: parseConfig(configRaw),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractForwarderSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.displayName`, message: 'Display name is required', code: 'required' })
    } else {
      const key = spec.displayName.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.displayName`, message: `Duplicate forwarder "${spec.displayName}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    // config is optional — a forwarder may be created with just a display name —
    // but when supplied it must be a JSON object.
    if (spec.configRaw && !spec.config) {
      errors.push({ field: `${prefix}.config`, message: 'Forwarder config must be a JSON object', code: 'invalid_json' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
