import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope AI Gateway custom AI provider constraints ----------------------

export interface AiProviderSpec {
  itemId?: string
  /** name — the logical identity (providers are id-addressed). */
  name: string
  /** Provider API schema/type (e.g. openai, azureopenai, anthropic). */
  schema: string
  host: string
  port: number
  protocol: string
  /** Optional TLS certificate — write-only (never returned by the API). */
  certificate: string
}

/** An AI provider as returned by GET /api/v2/aig/aiproviders. The certificate is
 *  never returned (write-only). */
export interface LiveAiProvider {
  provider_id?: number | string
  id?: number | string
  name?: string
  schema?: string
  host?: string
  port?: number
  protocol?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(asString(v))
  return Number.isFinite(n) && asString(v) !== '' ? n : fallback
}

export function liveAiProviderId(l: LiveAiProvider): string | undefined {
  const v = l.provider_id ?? l.id
  return v === undefined || v === null ? undefined : String(v)
}

export function extractAiProviderSpecs(canvas: CanvasSnapshot): AiProviderSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      schema: asString(f.schema),
      host: asString(f.host),
      port: asNumber(f.port, 0),
      protocol: asString(f.protocol),
      certificate: asString(f.certificate),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAiProviderSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate AI provider "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.schema) {
      errors.push({ field: `${prefix}.schema`, message: 'Schema is required', code: 'required' })
    }
    if (!spec.host) {
      errors.push({ field: `${prefix}.host`, message: 'Host is required', code: 'required' })
    }
    if (!spec.protocol) {
      errors.push({ field: `${prefix}.protocol`, message: 'Protocol is required', code: 'required' })
    }
    if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) {
      errors.push({ field: `${prefix}.port`, message: 'Port must be an integer between 1 and 65535', code: 'invalid_port' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
