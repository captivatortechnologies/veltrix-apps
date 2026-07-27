import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Workflow constraints --------------------------------------

export const MAX_NAME_LENGTH = 255

export interface WorkflowSpec {
  itemId?: string
  /** name — the natural key (unique per tenant); the id is stored for rename-safety. */
  name: string
  description: string
  ownerId: string
  /** raw JSON for the `trigger` object ({type, attributes}). */
  triggerRaw: string
  /** raw JSON for the `definition` object ({start, steps}). */
  definitionRaw: string
  enabled: boolean
}

/** A workflow as returned by GET /v3/workflows. */
export interface LiveWorkflow {
  id?: string
  name?: string
  description?: string | null
  owner?: { id?: string }
  trigger?: Record<string, unknown> | null
  definition?: Record<string, unknown> | null
  enabled?: boolean
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

export function extractWorkflowSpecs(canvas: CanvasSnapshot): WorkflowSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const asJson = (v: unknown): string =>
      typeof v === 'string' ? v.trim() : v && typeof v === 'object' ? JSON.stringify(v) : ''
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      ownerId: asString(f.ownerId),
      triggerRaw: asJson(f.trigger),
      definitionRaw: asJson(f.definition),
      enabled: asBool(f.enabled),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractWorkflowSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate workflow "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.ownerId) {
      errors.push({ field: `${prefix}.ownerId`, message: 'An owner Identity id is required', code: 'required' })
    }

    const trigger = parseJsonObject(spec.triggerRaw)
    if (!trigger.ok) {
      errors.push({ field: `${prefix}.trigger`, message: `Trigger must be a JSON object: ${trigger.error}`, code: 'invalid_trigger' })
    } else if (!spec.triggerRaw) {
      errors.push({ field: `${prefix}.trigger`, message: 'A trigger is required (e.g. {"type":"EVENT","attributes":{...}})', code: 'required' })
    } else if (!asString((trigger.value as { type?: unknown }).type)) {
      errors.push({ field: `${prefix}.trigger`, message: 'Trigger must declare a "type" (EVENT, SCHEDULED or EXTERNAL)', code: 'invalid_trigger' })
    }

    const definition = parseJsonObject(spec.definitionRaw)
    if (!definition.ok) {
      errors.push({ field: `${prefix}.definition`, message: `Definition must be a JSON object: ${definition.error}`, code: 'invalid_definition' })
    } else if (!spec.definitionRaw) {
      errors.push({ field: `${prefix}.definition`, message: 'A definition is required (e.g. {"start":"step1","steps":{...}})', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
