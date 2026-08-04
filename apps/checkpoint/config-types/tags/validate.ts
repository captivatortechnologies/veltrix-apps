import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { objectKey } from '../lib/checkpointShared'

// --- Shared types --------------------------------------------------------------

export interface TagSpec {
  itemId?: string
  /** name — the identity Check Point tag objects are matched on. */
  name: string
  comments: string
  color: string
}

/** A tag object as returned by show-tag / show-tags. Tags have no `tags` field of their own. */
export interface LiveTag {
  uid?: string
  name?: string
  comments?: string
  color?: string
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const tagKey = objectKey

export function extractTagSpecs(canvas: CanvasSnapshot): TagSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      comments: asString(f.comments),
      color: asString(f.color),
    }
  })
}

// --- Validate handler -----------------------------------------------------------

/**
 * Validate Check Point tag configurations: a name is required and unique
 * across the canvas (case-insensitive). A tag has no matching fields of its
 * own beyond identity.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractTagSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = tagKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate tag "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
