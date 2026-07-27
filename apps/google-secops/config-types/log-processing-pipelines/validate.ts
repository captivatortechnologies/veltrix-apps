import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps log processing pipeline constraints -----------------------
// The pipeline id is CLIENT-SETTABLE (a query param on create), so identity is a
// clean name key — no server-id round-trip needed.

/** logProcessingPipelineId: starts with a letter, letters/digits/underscore/hyphen. */
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,254}$/

export interface PipelineSpec {
  itemId?: string
  /** id = logProcessingPipelineId — the client-set immutable identity. */
  id: string
  displayName: string
  description: string
  processorsRaw: string
  /** Parsed processors array, or null when the JSON is malformed. */
  processors: unknown[] | null
}

/** A log processing pipeline as returned by the SecOps API. */
export interface LivePipeline {
  name?: string
  displayName?: string
  description?: string
  processors?: unknown[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse the processors JSON blob into an array, or null when it is not a JSON array. */
export function parseProcessors(raw: string): unknown[] | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

export function extractPipelineSpecs(canvas: CanvasSnapshot): PipelineSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const processorsRaw = asString(f.processors)
    return {
      itemId: item.id,
      id: asString(f.id) || item.name,
      displayName: asString(f.displayName),
      description: asString(f.description),
      processorsRaw,
      processors: parseProcessors(processorsRaw),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPipelineSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.id) {
      errors.push({ field: `${prefix}.id`, message: 'Pipeline id is required', code: 'required' })
    } else {
      if (!ID_RE.test(spec.id)) {
        errors.push({ field: `${prefix}.id`, message: 'Id must start with a letter and contain only letters, digits, underscores and hyphens', code: 'invalid_id' })
      }
      const key = spec.id.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.id`, message: `Duplicate pipeline "${spec.id}"`, code: 'duplicate_id' })
      }
      seen.add(key)
    }

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.displayName`, message: 'Display name is required', code: 'required' })
    }

    if (!spec.processorsRaw) {
      errors.push({ field: `${prefix}.processors`, message: 'Processors JSON is required', code: 'required' })
    } else if (!spec.processors) {
      errors.push({ field: `${prefix}.processors`, message: 'Processors must be a JSON array of processor steps', code: 'invalid_json' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
