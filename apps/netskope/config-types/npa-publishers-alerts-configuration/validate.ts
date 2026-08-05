import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope NPA publisher alerts configuration constraints -----------------
// SINGLETON — backed by /api/v2/infrastructure/publishers/alertsconfiguration.
// One tenant-wide alerting policy that applies automatically to every
// publisher; there is nothing to key on, so exactly one canvas item is
// expected. Unlike the rest of the REST API v2, this endpoint's JSON body
// uses camelCase keys (adminUsers/eventTypes/selectedUsers) — the canvas
// field keys match the wire format exactly.

export const EVENT_TYPES = ['UPGRADE_WILL_START', 'UPGRADE_STARTED', 'UPGRADE_SUCCEEDED', 'UPGRADE_FAILED', 'CONNECTION_FAILED'] as const
export type EventType = (typeof EVENT_TYPES)[number]
export const MAX_EVENT_TYPES = 5

export interface PublisherAlertsSpec {
  itemId?: string
  adminUsers: string[]
  eventTypes: string[]
  selectedUsers: string
}

/** The config as returned by GET .../alertsconfiguration (under a
 *  {data:{...}} envelope). */
export interface LivePublisherAlertsConfig {
  adminUsers?: string[]
  eventTypes?: string[]
  selectedUsers?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a textarea/array value into trimmed, non-empty entries. */
export function splitEntries(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function extractPublisherAlertsSpec(canvas: CanvasSnapshot): PublisherAlertsSpec {
  const items = canvas.items ?? canvas.sections ?? []
  const f = items[0]?.fields ?? {}
  return {
    itemId: items[0]?.id,
    adminUsers: splitEntries(f.adminUsers),
    eventTypes: splitEntries(f.eventTypes),
    selectedUsers: asString(f.selectedUsers),
  }
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the publisher alerts configuration.', code: 'required' })
    return { valid: false, errors, warnings }
  }
  if (items.length > 1) {
    warnings.push({ field: 'items', message: 'Publisher alerts configuration is a singleton; only the first item is applied.', code: 'singleton' })
  }

  const spec = extractPublisherAlertsSpec(ctx.canvas)

  if (spec.adminUsers.length === 0) {
    errors.push({ field: 'items[0].adminUsers', message: 'At least one admin user is required', code: 'required' })
  }

  if (spec.eventTypes.length === 0) {
    errors.push({ field: 'items[0].eventTypes', message: 'At least one event type is required', code: 'required' })
  } else if (spec.eventTypes.length > MAX_EVENT_TYPES) {
    errors.push({ field: 'items[0].eventTypes', message: `At most ${MAX_EVENT_TYPES} event types are allowed`, code: 'too_many' })
  }
  spec.eventTypes.forEach((t, i) => {
    if (!(EVENT_TYPES as readonly string[]).includes(t)) {
      errors.push({ field: `items[0].eventTypes[${i}]`, message: `"${t}" is not a valid event type — must be one of ${EVENT_TYPES.join(', ')}`, code: 'invalid_event_type' })
    }
  })

  if (!spec.selectedUsers) {
    errors.push({ field: 'items[0].selectedUsers', message: 'Selected users is required', code: 'required' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
