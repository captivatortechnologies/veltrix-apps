import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Carbon Black policy constraints -----------------------------------------

/** Sensor priority levels a policy can carry (Policy Service v1). */
export const PRIORITY_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'MISSION_CRITICAL'] as const

export interface PolicySpec {
  itemId?: string
  /** name — the policy's identity (matched by name). */
  name: string
  description: string
  priorityLevel: string
  /** parsed policy body (av_settings / rules / sensor_settings / ...); null if unparseable. */
  policyBody: Record<string, unknown> | null
  /** the raw textarea value, kept so validate can report parse errors. */
  policyJsonRaw: string
}

/** A policy as returned by /policies/summary. */
export interface LivePolicySummary {
  id?: number | string
  name?: string
  description?: string
  priority_level?: string
  is_system?: boolean
  position?: number
  num_devices?: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function parsePolicyBody(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const raw = (typeof f.policyJson === 'string' ? f.policyJson : '').trim()
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      priorityLevel: (asString(f.priorityLevel) || 'MEDIUM').toUpperCase(),
      policyBody: parsePolicyBody(raw),
      policyJsonRaw: raw,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPolicySpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) errors.push({ field: `${prefix}.name`, message: `Duplicate policy "${spec.name}"`, code: 'duplicate_name' })
      seen.add(key)
    }

    if (!(PRIORITY_LEVELS as readonly string[]).includes(spec.priorityLevel)) {
      errors.push({ field: `${prefix}.priorityLevel`, message: `Priority level must be one of: ${PRIORITY_LEVELS.join(', ')}`, code: 'invalid_priority' })
    }

    if (!spec.policyJsonRaw) {
      errors.push({ field: `${prefix}.policyJson`, message: 'Policy JSON is required (the av_settings / rules / sensor_settings body)', code: 'required' })
    } else if (!spec.policyBody) {
      errors.push({ field: `${prefix}.policyJson`, message: 'Policy JSON must be a valid JSON object', code: 'invalid_json' })
    } else {
      const body = spec.policyBody
      if (body.rules !== undefined && !Array.isArray(body.rules)) {
        errors.push({ field: `${prefix}.policyJson`, message: 'Policy JSON "rules" must be an array', code: 'invalid_rules' })
      }
      if (body.sensor_settings !== undefined && !Array.isArray(body.sensor_settings)) {
        errors.push({ field: `${prefix}.policyJson`, message: 'Policy JSON "sensor_settings" must be an array', code: 'invalid_sensor_settings' })
      }
      if (body.av_settings === undefined && body.rules === undefined && body.sensor_settings === undefined) {
        warnings.push({ field: `${prefix}.policyJson`, message: 'Policy JSON has no av_settings, rules or sensor_settings — the policy will have no protections', code: 'empty_policy' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
