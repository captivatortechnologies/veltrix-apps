import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps parser extension constraints ------------------------------
// A parser extension EXTENDS (does not replace) the base parser for a log type.
// Extensions are nested under a log type, immutable (no update) and promoted with
// :activate. This type manages the `cbnSnippet` extension path (one managed
// extension per log type); the field-extractors / dynamic-parsing paths are out
// of scope.

/** logType id: letters, digits and underscores (e.g. WINEVTLOG). */
const LOG_TYPE_RE = /^[A-Za-z0-9_]+$/

export interface ParserExtensionSpec {
  itemId?: string
  /** The log type id the extension belongs to — the identity (one managed extension per log type). */
  logType: string
  /** The CBN snippet source that extends the base parser. */
  cbnSnippet: string
  /** Optional raw sample log used to validate the snippet. */
  logSample: string
}

/** A parser extension as returned by the SecOps API. `name` is `.../logTypes/{logType}/parserExtensions/{id}`. */
export interface LiveParserExtension {
  name?: string
  /** Base64-encoded snippet. */
  cbnSnippet?: string
  state?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractParserExtensionSpecs(canvas: CanvasSnapshot): ParserExtensionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      logType: asString(f.logType) || item.name,
      cbnSnippet: typeof f.cbnSnippet === 'string' ? f.cbnSnippet : '',
      logSample: typeof f.logSample === 'string' ? f.logSample : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractParserExtensionSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.logType`, message: `Duplicate parser extension for log type "${spec.logType}" — only one is managed per log type`, code: 'duplicate_log_type' })
      }
      seen.add(key)
    }

    if (!spec.cbnSnippet.trim()) {
      errors.push({ field: `${prefix}.cbnSnippet`, message: 'A CBN snippet is required', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
