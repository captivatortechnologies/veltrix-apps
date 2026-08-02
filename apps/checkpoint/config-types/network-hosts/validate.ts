import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { isValidIpv4, isValidIpv6, liveTagNames, objectKey, sameStringSet, strList } from '../lib/checkpointShared'

// Re-exported so existing importers (deploy/rollback/driftDetect/healthCheck,
// tests) keep working unchanged — the implementations now live in the shared
// module reused by every Check Point config type.
export { strList, liveTagNames, sameStringSet, isValidIpv4, isValidIpv6 }
export const hostKey = objectKey

// --- Shared types --------------------------------------------------------------

export interface HostSpec {
  itemId?: string
  /** name — the identity Check Point host objects are matched on. */
  name: string
  ipv4Address: string
  ipv6Address: string
  comments: string
  color: string
  tags: string[]
}

/** A host object as returned by show-host / show-hosts. */
export interface LiveHost {
  uid?: string
  name?: string
  'ipv4-address'?: string
  'ipv6-address'?: string
  comments?: string
  color?: string
  /** Tags come back as plain strings or { name, uid, ... } summaries depending on details-level. */
  tags?: Array<string | { name?: string }>
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function extractHostSpecs(canvas: CanvasSnapshot): HostSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      ipv4Address: asString(f.ipv4Address),
      ipv6Address: asString(f.ipv6Address),
      comments: asString(f.comments),
      color: asString(f.color),
      tags: strList(f.tags),
    }
  })
}

// --- Validate handler -----------------------------------------------------------

/**
 * Validate Check Point host-object configurations: a name is required and
 * unique across the canvas (case-insensitive); at least one of IPv4 / IPv6
 * address must be set, and whichever is set must be a valid address; tags
 * must not contain empty values. Color is passed through untouched (Check
 * Point itself is the source of truth for the valid color-name enum).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractHostSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = hostKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate host "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (!spec.ipv4Address && !spec.ipv6Address) {
      errors.push({
        field: `${prefix}.ipv4Address`,
        message: 'A host needs an IPv4 and/or an IPv6 address',
        code: 'required',
      })
    }
    if (spec.ipv4Address && !isValidIpv4(spec.ipv4Address)) {
      errors.push({
        field: `${prefix}.ipv4Address`,
        message: `"${spec.ipv4Address}" is not a valid IPv4 address`,
        code: 'invalid_ip',
      })
    }
    if (spec.ipv6Address && !isValidIpv6(spec.ipv6Address)) {
      errors.push({
        field: `${prefix}.ipv6Address`,
        message: `"${spec.ipv6Address}" is not a valid IPv6 address`,
        code: 'invalid_ip',
      })
    }
    if (spec.tags.some((t) => t.length === 0)) {
      errors.push({ field: `${prefix}.tags`, message: 'Tags must not contain empty values', code: 'invalid_tag' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
