import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager firewall VIP group constraints -----------------------------

export const MAX_NAME_LENGTH = 79

export interface VipGroupSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** member virtual IP names. */
  members: string[]
  /** External interface all member VIPs share (optional). */
  interface: string
  /** Maps to the FortiManager `comments` (plural) field. */
  comment: string
}

/** A VIP group as returned by a get on the vipgrp table. */
export interface LiveVipGroup {
  name?: string
  member?: Array<string | { name?: string }>
  interface?: string | string[]
  comments?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a member value into trimmed names (by newline or comma). */
export function splitMembers(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

/** Normalize a live member array to plain names. */
export function liveMemberNames(v: LiveVipGroup['member']): string[] {
  return (v ?? []).map((m) => (typeof m === 'string' ? m : m?.name ?? '')).filter((n) => n.length > 0)
}

/** Normalize a scalar that may echo back as a single-element array. */
export function normalizeScalar(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim()
  return ''
}

export function extractVipGroupSpecs(canvas: CanvasSnapshot): VipGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      members: splitMembers(f.members),
      interface: asString(f.interface),
      comment: asString(f.comment),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractVipGroupSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate VIP group "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.members.length === 0) {
      errors.push({ field: `${prefix}.members`, message: 'A VIP group needs at least one member virtual IP', code: 'missing_members' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
