import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { liveTagNames, objectKey, strList } from '../lib/checkpointShared'

// --- Shared types --------------------------------------------------------------

export interface SecurityZoneSpec {
  itemId?: string
  /** name — the identity Check Point security-zone objects are matched on. */
  name: string
  comments: string
  color: string
  tags: string[]
}

/** A security-zone object as returned by show-security-zone / show-security-zones. */
export interface LiveSecurityZone {
  uid?: string
  name?: string
  comments?: string
  color?: string
  tags?: Array<string | { name?: string }>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const securityZoneKey = objectKey

export function extractSecurityZoneSpecs(canvas: CanvasSnapshot): SecurityZoneSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      comments: asString(f.comments),
      color: asString(f.color),
      tags: strList(f.tags),
    }
  })
}

/** Flatten a live security zone's tags (strings or object summaries) to plain tag names. */
export function liveZoneTagNames(tags: LiveSecurityZone['tags']): string[] {
  return liveTagNames(tags)
}

// --- Validate handler -----------------------------------------------------------

/**
 * Validate Check Point security-zone configurations: a name is required and
 * unique across the canvas (case-insensitive). A security zone has no
 * required matching fields beyond identity — it exists purely as a
 * reference point for interface anti-spoofing / zone-based rules.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSecurityZoneSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = securityZoneKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate security zone "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (spec.tags.some((t) => t.length === 0)) {
      errors.push({ field: `${prefix}.tags`, message: 'Tags must not contain empty values', code: 'invalid_tag' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
