import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Event Trigger Subscription constraints ---------------------
// HTTP subscriptions carry secret-bearing httpConfig (auth tokens): it is written
// on deploy but not drift-tracked. Scoped to the HTTP and EVENTBRIDGE types whose
// config objects are well-defined.

export const MAX_NAME_LENGTH = 128
export const TYPES = ['HTTP', 'EVENTBRIDGE'] as const

export interface TriggerSubscriptionSpec {
  itemId?: string
  name: string
  triggerId: string
  type: string
  description: string
  responseDeadline: string
  enabled: boolean
  filter: string
  /** raw JSON for httpConfig (HTTP) or eventBridgeConfig (EVENTBRIDGE). */
  configRaw: string
}

/** A trigger subscription as returned by GET /beta/trigger-subscriptions. */
export interface LiveTriggerSubscription {
  id?: string
  name?: string
  triggerId?: string
  type?: string
  description?: string | null
  responseDeadline?: string | null
  enabled?: boolean
  filter?: string | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function parseJsonObject(
  raw: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'must be a JSON object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

export function extractTriggerSubscriptionSpecs(canvas: CanvasSnapshot): TriggerSubscriptionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      triggerId: asString(f.triggerId),
      type: (asString(f.type) || 'HTTP').toUpperCase(),
      description: asString(f.description),
      responseDeadline: asString(f.responseDeadline) || 'PT1H',
      enabled: f.enabled === undefined ? true : asBool(f.enabled),
      filter: asString(f.filter),
      configRaw:
        typeof f.config === 'string'
          ? f.config.trim()
          : f.config && typeof f.config === 'object'
            ? JSON.stringify(f.config)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTriggerSubscriptionSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate trigger subscription "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.triggerId) {
      errors.push({ field: `${prefix}.triggerId`, message: 'A triggerId is required (e.g. "idn:access-requested")', code: 'required' })
    }
    if (!TYPES.includes(spec.type as (typeof TYPES)[number])) {
      errors.push({ field: `${prefix}.type`, message: `Type must be one of ${TYPES.join(', ')}`, code: 'invalid_enum' })
    }

    const parsed = parseJsonObject(spec.configRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.config`, message: `Config must be a JSON object: ${parsed.error}`, code: 'invalid_config' })
    } else if (!spec.configRaw) {
      errors.push({ field: `${prefix}.config`, message: `A ${spec.type} subscription requires a config object`, code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
