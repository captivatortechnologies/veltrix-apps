import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager explicit-proxy address group constraints -------------------

export const MAX_NAME_LENGTH = 79
export const PROXY_GROUP_TYPES = ['src', 'dst'] as const

export interface ProxyAddressGroupSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** src | dst — a src group holds src-type proxy addresses, dst holds dst-type. */
  type: string
  /** member proxy-address names. */
  members: string[]
  comment: string
}

/** A proxy address group as returned by a get on the proxy-addrgrp table. */
export interface LiveProxyAddressGroup {
  name?: string
  type?: string | number
  member?: Array<string | { name?: string }>
  comment?: string
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
export function liveMemberNames(v: LiveProxyAddressGroup['member']): string[] {
  return (v ?? []).map((m) => (typeof m === 'string' ? m : m?.name ?? '')).filter((n) => n.length > 0)
}

export function extractProxyAddressGroupSpecs(canvas: CanvasSnapshot): ProxyAddressGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: (asString(f.type) || 'src').toLowerCase(),
      members: splitMembers(f.members),
      comment: asString(f.comment),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractProxyAddressGroupSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate proxy address group "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(PROXY_GROUP_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Type must be one of: ${PROXY_GROUP_TYPES.join(', ')}`, code: 'invalid_type' })
    }

    if (spec.members.length === 0) {
      errors.push({ field: `${prefix}.members`, message: 'A proxy address group needs at least one member proxy address', code: 'missing_members' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
