import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { liveTagNames, objectKey, strList } from '../lib/checkpointShared'

// --- Shared types --------------------------------------------------------------

export interface GroupSpec {
  itemId?: string
  /** name — the identity Check Point group objects are matched on. */
  name: string
  /** Member object names — hosts, networks, address ranges, other groups, ... (any type, resolved by Check Point). */
  members: string[]
  comments: string
  color: string
  tags: string[]
}

/** A group object as returned by show-group / show-groups. */
export interface LiveGroup {
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

export const groupKey = objectKey

/** Flatten a live group's members (strings or { name } summaries) to plain member names. */
export function liveMemberNames(members: LiveGroup['members']): string[] {
  return liveTagNames(members)
}

export function extractGroupSpecs(canvas: CanvasSnapshot): GroupSpec[] {
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
 * Validate Check Point group configurations: a name is required and unique
 * across the canvas (case-insensitive). Members are optional (an empty group
 * is a valid Check Point object) — Check Point itself validates that each
 * declared member name resolves to a real object at deploy time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = groupKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate group "${spec.name}" — each name may only be declared once per canvas`,
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
