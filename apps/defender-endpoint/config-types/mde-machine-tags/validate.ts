// =============================================================================
// Defender for Endpoint MACHINE TAGS — spec model + validation.
//
// This config type manages device (machine) tags via the Defender API:
//   POST /api/machines/{id}/tags  { "Value": "<tag>", "Action": "Add"|"Remove" }
// (verified — needs the Machine.ReadWrite.All application permission). Each item
// declares ONE device (by its stable Defender device id, or by computer name)
// and the set of tags that should be present on it. Identity is the (deviceType,
// deviceValue) pair; a device's live tags come back on the Machine resource as
// the `machineTags` string collection.
//
// Like the detection-rules type (and unlike the shared indicator types), this
// type is self-contained in its directory: it owns the spec model, the Machine
// interface and the helpers, and the deploy / rollback / drift / health handlers
// import them from here. It reuses lib/mde.ts for the API client only.
//
// NOTE: Defender exposes NO public API to create or manage device GROUPS (they
// are portal-only, Settings > Endpoints > Permissions > Device groups) and NO
// API for web content filtering policies — so this type covers tags only.
// =============================================================================

import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/** How an item points at a device: its Defender device id, or its computer name. */
export const DEVICE_REF_TYPES = ['id', 'name'] as const
export type DeviceRefType = (typeof DEVICE_REF_TYPES)[number]

/** A Defender device id is a 40-character hex (SHA-1) string. */
const MACHINE_ID_PATTERN = /^[0-9a-fA-F]{40}$/
/** Documented ceiling for a tag via the registry / OMA-URI sync methods. */
export const MAX_TAG_LENGTH = 200

/** One declared device-tags assignment, extracted from a canvas item. */
export interface MachineTagSpec {
  sectionName: string
  deviceType: DeviceRefType
  deviceValue: string
  tags: string[]
}

/** A machine as returned by the /api/machines endpoints (the subset used here). */
export interface LiveMachine {
  id?: string
  computerDnsName?: string
  machineTags?: string[]
}

/** Normalize a tag for identity / presence comparison (trim + lowercase). */
export function tagKey(tag: string): string {
  return tag.trim().toLowerCase()
}

/** The (deviceType, deviceValue) natural key — a tagged device's identity. */
export function deviceKey(type: string, value: string): string {
  return JSON.stringify([type.trim().toLowerCase(), value.trim().toLowerCase()])
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Read a tags field into a trimmed, de-duplicated array (accepts a comma string too). */
function readTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v).trim())
    : typeof value === 'string'
      ? value.split(',').map((v) => v.trim())
      : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of raw) {
    if (!tag) continue
    const key = tagKey(tag)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/** Each canvas item describes one device and the tags it should carry. */
export function extractMachineTagSpecs(canvas: CanvasSnapshot): MachineTagSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawType = readString(fields.device_type).toLowerCase()
    const deviceType: DeviceRefType = rawType === 'name' ? 'name' : 'id'
    return {
      sectionName: section.name,
      deviceType,
      deviceValue: readString(fields.device_value),
      tags: readTags(fields.tags),
    }
  })
}

/**
 * Validate declared device tags: each item needs a device reference (a 40-hex
 * device id when referenced by id) and at least one tag; the same device must
 * not be declared twice. Over-long tags and tags with commas / parentheses are
 * warnings (documented sync / filtering caveats), not errors.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no device tag items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractMachineTagSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!DEVICE_REF_TYPES.includes(spec.deviceType)) {
      errors.push({ field: `${prefix}.device_type`, message: `Unsupported device reference type "${spec.deviceType}"`, code: 'invalid_device_type' })
    }

    if (!spec.deviceValue) {
      errors.push({ field: `${prefix}.device_value`, message: 'Device is required', code: 'required' })
    } else if (spec.deviceType === 'id' && !MACHINE_ID_PATTERN.test(spec.deviceValue)) {
      errors.push({ field: `${prefix}.device_value`, message: 'Device ID must be a 40-character hex Defender device id (or reference the device by computer name)', code: 'invalid_device_id' })
    }

    if (spec.tags.length === 0) {
      errors.push({ field: `${prefix}.tags`, message: 'At least one tag is required', code: 'required' })
    }

    for (const tag of spec.tags) {
      if (tag.length > MAX_TAG_LENGTH) {
        warnings.push({ field: `${prefix}.tags`, message: `Tag "${tag.slice(0, 24)}…" exceeds ${MAX_TAG_LENGTH} characters — it may not sync via all tagging methods`, code: 'tag_too_long' })
      }
      if (/[,()]/.test(tag)) {
        warnings.push({ field: `${prefix}.tags`, message: `Tag "${tag}" contains a comma or parenthesis — device-list filtering may not work on it`, code: 'tag_special_chars' })
      }
    }

    if (spec.deviceValue) {
      const key = deviceKey(spec.deviceType, spec.deviceValue)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.device_value`, message: `Duplicate device "${spec.deviceValue}" — merge its tags into a single item`, code: 'duplicate_device' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
