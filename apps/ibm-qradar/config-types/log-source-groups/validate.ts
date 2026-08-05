import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar log source group constraints ---------------------------------
//
// POST /config/event_sources/log_source_management/log_source_groups creates a
// group (name, description, parent_id). There is no update or delete endpoint,
// so this type is APPEND-ONLY: deploy creates any declared group that is
// missing, but groups this app creates can never be renamed, re-parented or
// removed via the API. Identity is the group name; the parent is declared by
// NAME and resolved to parent_id in deploy (a blank parent means root).

export interface LogSourceGroupSpec {
  itemId?: string
  /** name — the group's identity (matched by name; append-only, cannot be renamed). */
  name: string
  description: string
  /** the parent group's name, resolved to parent_id in deploy; empty = root. */
  parentName: string
}

/** A log source group as returned by GET .../log_source_groups (see lib/lookups.ts). */
export interface LiveLogSourceGroup {
  id?: number
  name?: string
  description?: string
  parent_id?: number
  owner?: string
  modification_date?: number
  assignable?: boolean
  child_group_ids?: number[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractLogSourceGroupSpecs(canvas: CanvasSnapshot): LogSourceGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      parentName: asString(f.parentName),
    }
  })
}

/** Detects a parent-chain cycle formed entirely by names declared in this canvas. */
function findCycle(specs: LogSourceGroupSpec[]): string | undefined {
  const byName = new Map(specs.filter((s) => s.name).map((s) => [s.name.toLowerCase(), s]))
  for (const spec of specs) {
    if (!spec.name) continue
    const seen = new Set<string>()
    let current: LogSourceGroupSpec | undefined = spec
    while (current?.parentName) {
      const key = current.name.toLowerCase()
      if (seen.has(key)) return spec.name
      seen.add(key)
      current = byName.get(current.parentName.toLowerCase())
    }
  }
  return undefined
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractLogSourceGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > 255) {
        errors.push({ field: `${prefix}.name`, message: 'Name must be 255 characters or fewer', code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate log source group "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)

      if (spec.parentName && spec.parentName.toLowerCase() === key) {
        errors.push({ field: `${prefix}.parentName`, message: 'A group cannot be its own parent', code: 'self_parent' })
      }
    }

    if (spec.description.length > 255) {
      errors.push({ field: `${prefix}.description`, message: 'Description must be 255 characters or fewer', code: 'too_long' })
    }
  })

  const cycleAt = findCycle(specs)
  if (cycleAt) {
    errors.push({ field: 'items', message: `Parent chain forms a cycle starting at "${cycleAt}"`, code: 'parent_cycle' })
  }

  if (specs.length > 0) {
    warnings.push({ field: 'items', message: 'Log source groups are append-only: this app cannot rename, re-parent or remove groups it creates', code: 'append_only' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
