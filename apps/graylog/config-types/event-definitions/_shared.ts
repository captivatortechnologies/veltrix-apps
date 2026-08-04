// Shared helpers for the Graylog Event Definitions config type (validate +
// deploy + rollback + drift). Shapes follow the Graylog REST API
// (/api/events/definitions):
//   • POST body  = CreateEntityRequest<EventDefinitionDto> { entity: {...},
//                  share_request: null } (?schedule=true|false query param)
//   • PUT  body  = EventDefinitionDto { id, ... } — id MUST equal the URL's
//                  {definitionId} (?schedule=true|false query param)
//   • GET  response = `{ event_definitions: [EventDefinitionDto] }`
//                  (deprecated bare list; used here for its simplicity)
// `config` is a typed, discriminated blob — `config.type` selects the event
// processor (e.g. "aggregation-v1", "sigma-v1"). `priority` is an integer:
// 0 info, 1 low, 2 medium, 3 high, 4 critical (EventDefinitionPriorityEnum).
// `schedule=false` creates/updates the definition DISABLED (State.DISABLED)
// instead of scheduling it. Source: org.graylog.events.rest.
// EventDefinitionsResource, org.graylog.events.processor.EventDefinitionDto,
// org.graylog.security.shares.CreateEntityRequest (@ 6.1).

import { asString, toBool, toInt, parseJsonObject } from '../../lib/coerce'

/** EventDefinitionPriorityEnum — the integer `priority` field's meaning. */
export const EVENT_PRIORITIES: Record<number, string> = {
  0: 'info',
  1: 'low',
  2: 'medium',
  3: 'high',
  4: 'critical',
}

/** One event definition as returned by GET /api/events/definitions (EventDefinitionDto). */
export interface GraylogEventDefinition {
  id?: string
  title?: string
  description?: string
  priority?: number
  alert?: boolean
  config?: Record<string, unknown>
  field_spec?: Record<string, unknown>
  key_spec?: string[]
  notification_settings?: Record<string, unknown>
  notifications?: Array<Record<string, unknown>>
  storage?: Array<Record<string, unknown>>
  tags?: string[]
  state?: string
  [key: string]: unknown
}

/** GET /api/events/definitions envelope: `{ event_definitions: [...] }`. */
interface EventDefinitionsListResponse {
  event_definitions?: GraylogEventDefinition[]
}

/** Entity body (no id) sent inside CreateEntityRequest on POST /api/events/definitions. */
export interface EventDefinitionEntityBody {
  title: string
  description: string
  priority: number
  alert: boolean
  config: Record<string, unknown>
  field_spec: Record<string, unknown>
  key_spec: string[]
  notification_settings: Record<string, unknown>
  notifications: Array<Record<string, unknown>>
  storage: Array<Record<string, unknown>>
  tags: string[]
}

/** Unwrap GET /api/events/definitions into a flat array of event definitions. */
export function eventDefinitionsFromList(list: unknown): GraylogEventDefinition[] {
  if (Array.isArray(list)) return list as GraylogEventDefinition[]
  const defs = (list as EventDefinitionsListResponse | null)?.event_definitions
  return Array.isArray(defs) ? defs : []
}

/** Find a live event definition by title (the stable identity used for upsert + drift). */
export function findEventDefinition(defs: GraylogEventDefinition[], title: string): GraylogEventDefinition | null {
  const t = asString(title)
  if (!t) return null
  return defs.find((d) => asString(d.title) === t) ?? null
}

/** Parse a canvas field that carries a JSON array (of any element type). Blank is a valid empty array. */
function parseJsonArray(value: unknown, fieldLabel: string): { value: unknown[]; error?: string } {
  if (value == null || value === '') return { value: [] }
  let raw: unknown = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return { value: [] }
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return { value: [], error: `${fieldLabel} is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
    }
  }
  if (!Array.isArray(raw)) return { value: [], error: `${fieldLabel} must be a JSON array` }
  return { value: raw }
}

export interface BuiltEventDefinitionEntity {
  entity?: EventDefinitionEntityBody
  schedule: boolean
  error?: string
}

/** Build the EventDefinitionDto entity body + schedule flag from canvas fields. */
export function buildEventDefinitionEntity(fields: Record<string, unknown>): BuiltEventDefinitionEntity {
  const { value: config, error: configError } = parseJsonObject(fields.config)
  if (configError) return { error: `config ${configError}`, schedule: true }
  if (!asString(config.type)) return { error: 'config.type is required (e.g. "aggregation-v1")', schedule: true }

  const { value: fieldSpec, error: fieldSpecError } = parseJsonObject(fields.field_spec)
  if (fieldSpecError) return { error: `field_spec ${fieldSpecError}`, schedule: true }

  const { value: keySpecRaw, error: keySpecError } = parseJsonArray(fields.key_spec, 'key_spec')
  if (keySpecError) return { error: keySpecError, schedule: true }

  const { value: notificationSettings, error: notificationSettingsError } = parseJsonObject(fields.notification_settings)
  if (notificationSettingsError) return { error: `notification_settings ${notificationSettingsError}`, schedule: true }

  const { value: notificationsRaw, error: notificationsError } = parseJsonArray(fields.notifications, 'notifications')
  if (notificationsError) return { error: notificationsError, schedule: true }

  const { value: storageRaw, error: storageError } = parseJsonArray(fields.storage, 'storage')
  if (storageError) return { error: storageError, schedule: true }

  const { value: tagsRaw, error: tagsError } = parseJsonArray(fields.tags, 'tags')
  if (tagsError) return { error: tagsError, schedule: true }

  return {
    schedule: toBool(fields.enabled ?? true),
    entity: {
      title: asString(fields.title),
      description: asString(fields.description),
      priority: toInt(fields.priority, 2),
      alert: toBool(fields.alert ?? true),
      config,
      field_spec: fieldSpec,
      key_spec: keySpecRaw.map((v) => String(v)),
      notification_settings: Object.keys(notificationSettings).length > 0
        ? notificationSettings
        : { grace_period_ms: 0, backlog_size: 0 },
      notifications: notificationsRaw as Array<Record<string, unknown>>,
      storage: storageRaw as Array<Record<string, unknown>>,
      tags: tagsRaw.map((v) => String(v)),
    },
  }
}

/** Server-computed fields that must not be sent back on a PUT restore. */
const READ_ONLY_KEYS = ['scheduler', 'updated_at', 'matched_at']

/** Build a restore body from a live event definition (rollback) — includes the id PUT requires. */
export function bodyFromLiveEventDefinition(def: GraylogEventDefinition): GraylogEventDefinition {
  const body: GraylogEventDefinition = { ...def }
  for (const key of READ_ONLY_KEYS) delete body[key]
  return body
}
