import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar log-source constraints ---------------------------------------
//
// Bounded scope: this type manages the log source's top-level scalars plus a
// validated protocol-parameter list. The log source TYPE and PROTOCOL are
// declared by NAME; deploy resolves each name to its numeric id against the
// read-only log_source_types / protocol_types endpoints, and fills each
// protocol parameter's id from the chosen protocol type definition. Validate is
// structural only (it cannot reach the API) — the name -> id mapping happens in
// deploy where a credential is guaranteed.

export interface ProtocolParam {
  name: string
  value: string
}

export interface LogSourceSpec {
  itemId?: string
  /** name — the log source's natural identity (matched by name, rename-safe by id). */
  name: string
  /** the log source type name, resolved to type_id in deploy. */
  typeName: string
  /** the protocol type name, resolved to protocol_type_id in deploy. */
  protocolName: string
  /** raw protocol-parameter blob (a JSON array of { name, value }). */
  protocolParametersRaw: string
  enabled: boolean
  description: string
  credibility?: number
}

/** A log source as returned by GET .../log_sources. */
export interface LiveLogSource {
  id?: number
  name?: string
  type_id?: number
  protocol_type_id?: number
  enabled?: boolean
  description?: string
  credibility?: number
  internal?: boolean
  protocol_parameters?: Array<{ id?: number; name?: string; value?: string }>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse the raw protocol-parameter blob (a JSON array of { name, value }). */
export function parseProtocolParameters(raw: string): { params: ProtocolParam[]; error?: string } {
  const text = raw.trim()
  if (!text) return { params: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { params: [], error: 'protocol parameters must be a JSON array of { "name", "value" }' }
  }
  if (!Array.isArray(parsed)) return { params: [], error: 'protocol parameters must be a JSON array' }
  const params: ProtocolParam[] = []
  for (const p of parsed) {
    const name = p && typeof p === 'object' ? asString((p as Record<string, unknown>).name) : ''
    const value = p && typeof p === 'object' ? String((p as Record<string, unknown>).value ?? '') : ''
    params.push({ name, value })
  }
  return { params }
}

export function extractLogSourceSpecs(canvas: CanvasSnapshot): LogSourceSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const rawParams =
      typeof f.protocolParameters === 'string'
        ? f.protocolParameters
        : f.protocolParameters != null
          ? JSON.stringify(f.protocolParameters)
          : ''
    const cred = f.credibility
    const credibility =
      typeof cred === 'number' ? cred : typeof cred === 'string' && /^\d+$/.test(cred.trim()) ? Number(cred.trim()) : undefined
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      typeName: asString(f.typeName),
      protocolName: asString(f.protocolName),
      protocolParametersRaw: rawParams,
      enabled: f.enabled !== false,
      description: asString(f.description),
      credibility,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractLogSourceSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate log source "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
      if (spec.name.length > 255) {
        errors.push({ field: `${prefix}.name`, message: 'Name must be 255 characters or fewer', code: 'too_long' })
      }
    }

    if (!spec.typeName) {
      errors.push({ field: `${prefix}.typeName`, message: 'Log source type name is required', code: 'required' })
    }
    if (!spec.protocolName) {
      errors.push({ field: `${prefix}.protocolName`, message: 'Protocol name is required', code: 'required' })
    }

    const { params, error } = parseProtocolParameters(spec.protocolParametersRaw)
    if (error) {
      errors.push({ field: `${prefix}.protocolParameters`, message: error, code: 'invalid_protocol_parameters' })
    } else {
      params.forEach((p, pi) => {
        if (!p.name) errors.push({ field: `${prefix}.protocolParameters[${pi}].name`, message: 'Each protocol parameter needs a name', code: 'missing_param_name' })
      })
      if (params.length === 0) {
        warnings.push({ field: `${prefix}.protocolParameters`, message: 'No protocol parameters declared; most protocols require some', code: 'empty_protocol_parameters' })
      }
    }

    if (spec.credibility !== undefined && (spec.credibility < 0 || spec.credibility > 10)) {
      errors.push({ field: `${prefix}.credibility`, message: 'Credibility must be between 0 and 10', code: 'out_of_range' })
    }

    if (!spec.description) {
      warnings.push({ field: `${prefix}.description`, message: 'This log source has no description', code: 'empty_description' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
