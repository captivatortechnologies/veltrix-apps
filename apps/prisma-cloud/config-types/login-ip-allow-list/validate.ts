import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud login IP allow list constraints ----------------------------

export const MAX_NAME_LENGTH = 255
export const MAX_DESC_LENGTH = 2000
export const MAX_CIDRS = 10

/** Loose CIDR check — IPv4/IPv6 address followed by an optional /prefix. */
const CIDR_RE = /^([0-9]{1,3}(\.[0-9]{1,3}){3}(\/([0-9]|[12][0-9]|3[0-2]))?|[0-9a-fA-F:]+(\/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8]))?)$/

export interface LoginIpAllowSpec {
  itemId?: string
  /** name — the identity (Prisma matches login IP allow lists by name). */
  name: string
  description: string
  /** CIDR blocks allowed to log in (1–10). */
  cidr: string[]
}

/** A login IP allow list as returned by GET /ip_allow_list_login. */
export interface LiveLoginIpAllow {
  id?: string
  name?: string
  description?: string | null
  cidr?: string[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function splitCidrs(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function extractLoginIpAllowSpecs(canvas: CanvasSnapshot): LoginIpAllowSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      cidr: splitCidrs(f.cidr),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractLoginIpAllowSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate login IP allow list "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.description.length > MAX_DESC_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESC_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (spec.cidr.length === 0) {
      errors.push({ field: `${prefix}.cidr`, message: 'At least one CIDR block is required', code: 'required' })
    } else if (spec.cidr.length > MAX_CIDRS) {
      errors.push({ field: `${prefix}.cidr`, message: `A login IP allow list may hold at most ${MAX_CIDRS} CIDR blocks`, code: 'too_many_cidrs' })
    }
    for (const c of spec.cidr) {
      if (!CIDR_RE.test(c)) {
        errors.push({ field: `${prefix}.cidr`, message: `"${c}" is not a valid CIDR block`, code: 'invalid_cidr' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
