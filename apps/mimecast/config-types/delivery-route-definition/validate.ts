import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Mimecast Delivery Route definition constraints (Policy Management v1) --

const MIN_PORT = 1
const MAX_PORT = 65535

export interface DeliveryRouteDefinitionSpec {
  itemId?: string
  /** description — the definition identity. */
  description: string
  hostname: string
  port: number
  /** optional secure id of another definition to fail over to. */
  alternateRouteId: string
}

/**
 * A delivery route definition as returned by the v1 API. `smtpAuthentication`
 * may be present on a live record (configured out-of-band) but is never read
 * or written by this config type — see the canvas.yaml note.
 */
export interface LiveDeliveryRouteDefinition {
  id?: string
  description?: string
  hostname?: string
  port?: number
  alternateRouteId?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asPort(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 25
}

export function extractDeliveryRouteDefinitionSpecs(canvas: CanvasSnapshot): DeliveryRouteDefinitionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asString(f.description) || item.name,
      hostname: asString(f.hostname),
      port: asPort(f.port),
      alternateRouteId: asString(f.alternateRouteId),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDeliveryRouteDefinitionSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required (it is the definition identity)', code: 'required' })
    } else {
      const key = spec.description.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.description`, message: `Duplicate definition "${spec.description}"`, code: 'duplicate_description' })
      }
      seen.add(key)
    }

    if (!spec.hostname) {
      errors.push({ field: `${prefix}.hostname`, message: 'Hostname is required', code: 'required' })
    }

    if (!Number.isInteger(spec.port) || spec.port < MIN_PORT || spec.port > MAX_PORT) {
      errors.push({ field: `${prefix}.port`, message: `Port must be an integer between ${MIN_PORT} and ${MAX_PORT}`, code: 'invalid_port' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
