// =============================================================================
// Defender for Endpoint DEVICE VALUES — spec model + validation.
//
// This config type manages a device's business criticality via the Defender API:
//   PATCH /api/machines/{id}  { "deviceValue": "Normal"|"Low"|"High" }
// (verified — needs the Machine.ReadWrite.All application permission). Each item
// declares ONE device (by its stable Defender device id, or by computer name)
// and the criticality it should carry. `deviceValue` is a SINGLE-VALUED property
// on the Machine resource, so a device may own exactly one criticality — the
// same device declared twice is rejected.
//
// Like the machine-tags type, this type is self-contained in its directory: it
// owns the spec model, the Machine interface and the helpers, and the deploy /
// rollback / drift / health handlers import them from here. It reuses lib/mde.ts
// for the API client only.
// =============================================================================

import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/** How an item points at a device: its Defender device id, or its computer name. */
export const DEVICE_REF_TYPES = ['id', 'name'] as const
export type DeviceRefType = (typeof DEVICE_REF_TYPES)[number]

/** The Defender `deviceValue` business-criticality values. */
export const DEVICE_VALUES = ['Normal', 'Low', 'High'] as const
export type DeviceValue = (typeof DEVICE_VALUES)[number]

/** A Defender device id is a 40-character hex (SHA-1) string. */
const MACHINE_ID_PATTERN = /^[0-9a-fA-F]{40}$/

/** One declared device-value assignment, extracted from a canvas item. */
export interface DeviceValueSpec {
  sectionName: string
  deviceType: DeviceRefType
  device: string
  criticality: DeviceValue
}

/** A machine as returned by the /api/machines endpoints (the subset used here). */
export interface LiveMachine {
  id?: string
  computerDnsName?: string
  deviceValue?: string
}

/** The (deviceType, device) natural key — a device's identity, case-insensitive. */
export function deviceKey(type: string, value: string): string {
  return JSON.stringify([type.trim().toLowerCase(), value.trim().toLowerCase()])
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Each canvas item describes one device and the criticality it should carry. */
export function extractDeviceValueSpecs(canvas: CanvasSnapshot): DeviceValueSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawType = readString(fields.device_type).toLowerCase()
    const deviceType = (rawType || 'id') as DeviceRefType
    return {
      sectionName: section.name,
      deviceType,
      device: readString(fields.device),
      criticality: readString(fields.criticality) as DeviceValue,
    }
  })
}

/**
 * Validate declared device values: each item needs a device reference (a 40-hex
 * device id when referenced by id) and a criticality in {Normal, Low, High};
 * the reference type must be id or name; and — because `deviceValue` is single
 * valued — the same device must not be declared twice.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no device value items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDeviceValueSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!DEVICE_REF_TYPES.includes(spec.deviceType)) {
      errors.push({ field: `${prefix}.device_type`, message: `Unsupported device reference type "${spec.deviceType}"`, code: 'invalid_device_type' })
    }

    if (!spec.device) {
      errors.push({ field: `${prefix}.device`, message: 'Device is required', code: 'required' })
    } else if (spec.deviceType === 'id' && !MACHINE_ID_PATTERN.test(spec.device)) {
      errors.push({ field: `${prefix}.device`, message: 'Device ID must be a 40-character hex Defender device id (or reference the device by computer name)', code: 'invalid_device_id' })
    }

    if (!spec.criticality) {
      errors.push({ field: `${prefix}.criticality`, message: 'Business criticality is required', code: 'required' })
    } else if (!DEVICE_VALUES.includes(spec.criticality)) {
      errors.push({ field: `${prefix}.criticality`, message: `Business criticality must be one of ${DEVICE_VALUES.join(', ')}`, code: 'invalid_criticality' })
    }

    if (spec.device) {
      const key = deviceKey(spec.deviceType, spec.device)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.device`, message: `Duplicate device "${spec.device}" — a device can own only one criticality value`, code: 'duplicate_device' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
