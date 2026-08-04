import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { liveTagNames, objectKey, strList } from '../lib/checkpointShared'

// --- Shared types --------------------------------------------------------------

export interface ServiceGroupSpec {
  itemId?: string
  /** name — the identity Check Point service-group objects are matched on. */
  name: string
  /** Member service object names (TCP/UDP/other service objects, or other service groups). */
  members: string[]
  comments: string
  color: string
  tags: string[]
}

/** A service-group object as returned by show-service-group / show-service-groups. */
export interface LiveServiceGroup {
  uid?: string
  name?: string
  members?: Array<string | { name?: string }>
  comments?: string
  color?: string
  tags?: Array<string | { name?: string }>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const serviceGroupKey = objectKey

/** Flatten a live service-group's members (strings or { name } summaries) to plain names. */
export function liveMemberNames(members: LiveServiceGroup['members']): string[] {
  return liveTagNames(members)
}

export function extractServiceGroupSpecs(canvas: CanvasSnapshot): ServiceGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      members: strList(f.members),
      comments: asString(f.comments),
      color: asString(f.color),
      tags: strList(f.tags),
    }
  })
}

// --- Validate handler -----------------------------------------------------------

/**
 * Validate Check Point service-group configurations: a name is required and
 * unique across the canvas (case-insensitive). Members are optional (an
 * empty group is a valid Check Point object).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractServiceGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = serviceGroupKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate service group "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (spec.members.some((m) => m.length === 0)) {
      errors.push({ field: `${prefix}.members`, message: 'Members must not contain empty values', code: 'invalid_member' })
    }
    if (spec.tags.some((t) => t.length === 0)) {
      errors.push({ field: `${prefix}.tags`, message: 'Tags must not contain empty values', code: 'invalid_tag' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
