import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra lifecycle-workflow constraints ------------------------------------
//
// executionConditions and tasks are managed as validated JSON. Requires a
// Microsoft Entra ID Governance license at runtime.

export const MAX_DISPLAY_NAME_LENGTH = 256
export const WORKFLOW_CATEGORIES = new Set(['joiner', 'leaver', 'mover'])

export interface WorkflowSpec {
  itemId?: string
  /** displayName — the logical identity live workflows are matched on. */
  name: string
  category: string
  description: string
  isEnabled: boolean
  isSchedulingEnabled: boolean
  executionConditions: string
  tasks: string
}

/** A lifecycle workflow as returned by Graph. */
export interface LiveWorkflow {
  id?: string
  category?: string
  displayName?: string
  description?: string | null
  isEnabled?: boolean
  isSchedulingEnabled?: boolean
  executionConditions?: unknown
  tasks?: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function parseObject(text: string): Record<string, unknown> | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

export function parseArray(text: string): unknown[] | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortValue((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

export function canonical(v: unknown): string {
  return JSON.stringify(sortValue(v ?? null))
}

export function extractWorkflowSpecs(canvas: CanvasSnapshot): WorkflowSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      category: asString(f.category),
      description: asString(f.description),
      isEnabled: asBool(f.isEnabled),
      isSchedulingEnabled: asBool(f.isSchedulingEnabled),
      executionConditions: asString(f.executionConditions),
      tasks: asString(f.tasks),
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

    if (!spec.name) errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) errors.push({ field: `${prefix}.name`, message: `Duplicate workflow "${spec.name}"`, code: 'duplicate_name' })
      seenNames.add(key)
    }

    if (!spec.category) errors.push({ field: `${prefix}.category`, message: 'Category is required', code: 'required' })
    else if (!WORKFLOW_CATEGORIES.has(spec.category)) {
      errors.push({ field: `${prefix}.category`, message: `Category must be one of ${[...WORKFLOW_CATEGORIES].join(', ')}`, code: 'invalid_category' })
    }

    if (!parseObject(spec.executionConditions)) {
      errors.push({ field: `${prefix}.executionConditions`, message: 'Execution conditions is required and must be a valid JSON object', code: 'invalid_execution_conditions' })
    }
    if (!parseArray(spec.tasks) || (parseArray(spec.tasks) ?? []).length === 0) {
      errors.push({ field: `${prefix}.tasks`, message: 'Tasks is required and must be a non-empty JSON array', code: 'invalid_tasks' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
