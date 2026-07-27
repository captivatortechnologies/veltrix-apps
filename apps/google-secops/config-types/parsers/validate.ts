import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps custom parser constraints ---------------------------------
// Parsers are nested under a log type and are IMMUTABLE + versioned: there is no
// update. "Editing" a parser means creating a new version and activating it. Only
// one custom parser is active per log type, so this type keys by log type.

/** logType id: letters, digits and underscores (e.g. WINEVTLOG, CUSTOM_APP). */
const LOG_TYPE_RE = /^[A-Za-z0-9_]+$/

export interface ParserSpec {
  itemId?: string
  /** The log type id the parser belongs to — the identity (one active parser per log type). */
  logType: string
  /** The parser (CBN / Logstash-style) source code. */
  code: string
}

/** A parser as returned by the SecOps API. `name` is `.../logTypes/{logType}/parsers/{id}`. */
export interface LiveParser {
  name?: string
  /** Base64-encoded parser code. */
  cbn?: string
  /** ACTIVE | INACTIVE | ... */
  state?: string
  type?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractParserSpecs(canvas: CanvasSnapshot): ParserSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      logType: asString(f.logType) || item.name,
      code: typeof f.code === 'string' ? f.code : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractParserSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.logType) {
      errors.push({ field: `${prefix}.logType`, message: 'Log type is required', code: 'required' })
    } else {
      if (!LOG_TYPE_RE.test(spec.logType)) {
        errors.push({ field: `${prefix}.logType`, message: 'Log type must contain only letters, digits and underscores (e.g. WINEVTLOG)', code: 'invalid_log_type' })
      }
      const key = spec.logType.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.logType`, message: `Duplicate parser for log type "${spec.logType}" — only one active parser is managed per log type`, code: 'duplicate_log_type' })
      }
      seen.add(key)
    }

    if (!spec.code.trim()) {
      errors.push({ field: `${prefix}.code`, message: 'Parser code is required', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
