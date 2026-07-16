import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { memberList, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

export const RESOURCE_PATH = '/Objects/Addresses'

/** The three address value types; the type name is also the PAN-OS body key. */
export const ADDRESS_TYPES = ['ip-netmask', 'ip-range', 'fqdn'] as const
export type AddressType = (typeof ADDRESS_TYPES)[number]

export interface AddressSpec {
  sectionName: string
  name: string
  type: string
  value: string
  description: string
  tags: string[]
}

export interface LiveAddress extends PanoramaEntry {
  'ip-netmask'?: string
  'ip-range'?: string
  fqdn?: string
  description?: string
  tag?: { member?: string[] }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function extractAddressSpecs(canvas: CanvasSnapshot): AddressSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      type: str(fields.type) || 'ip-netmask',
      value: str(fields.value),
      description: str(fields.description),
      tags: splitList(fields.tags),
    }
  })
}

/** Build the REST entry fields for an address object. */
export function buildAddressFields(spec: AddressSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = { [spec.type]: spec.value }
  if (spec.description) fields.description = spec.description
  const tag = memberList(spec.tags)
  if (tag) fields.tag = tag
  return fields
}

export function addressUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractAddressSpecs(canvas)
    .filter((s) => s.name && s.value && ADDRESS_TYPES.includes(s.type as AddressType))
    .map((s) => ({ name: s.name, fields: buildAddressFields(s) }))
}

export function addressDriftDiffs(spec: AddressSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveAddress
  const liveValue = str(live[spec.type as keyof LiveAddress] as unknown)
  if (liveValue !== spec.value) {
    diffs.push({ field: `${spec.name}.${spec.type}`, expected: spec.value, actual: liveValue || 'not set', severity: 'warning' })
  }
  if (spec.description && str(live.description) !== spec.description) {
    diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: str(live.description) || 'not set', severity: 'info' })
  }
  return diffs
}

/**
 * Validate address objects: a name, a supported type and a value are required,
 * and the name is unique across the canvas. Exactly one address value type is
 * carried per object (the selected type).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  for (const spec of extractAddressSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Address name is required', code: 'required' })
    }
    if (!ADDRESS_TYPES.includes(spec.type as AddressType)) {
      errors.push({ field: `${prefix}.type`, message: `Unsupported address type "${spec.type}"`, code: 'invalid_type' })
    }
    if (!spec.value) {
      errors.push({ field: `${prefix}.value`, message: 'Address value is required', code: 'required' })
    } else if (spec.type === 'ip-range' && !spec.value.includes('-')) {
      errors.push({ field: `${prefix}.value`, message: 'An ip-range value must be "start-end"', code: 'invalid_value' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate address "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
