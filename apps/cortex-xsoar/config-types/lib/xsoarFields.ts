// =============================================================================
// Cortex XSOAR Incident/Indicator Fields — shared plumbing.
//
// Incident fields and indicator fields are the SAME underlying server object
// (a custom "field" definition) distinguished by two markers that always travel
// together: the `group` number (0 = incident field, 2 = indicator field — the
// server's own GroupFieldTypes enum) and the `id` prefix ("incident_" /
// "indicator_"). Both kinds are read from ONE endpoint (GET /incidentfields,
// confirmed via demisto-sdk's `Downloader.ITEM_TYPE_TO_ENDPOINT[FIELD]`) and
// written through ONE import endpoint (POST /incidentfields/import — confirmed
// via demisto-py's generated `import_incident_fields` and demisto-sdk's
// `IndicatorIncidentField._upload`, which wraps the field under the JSON key
// "incidentFields" regardless of which kind it is).
//
// A field's `id` is never authored directly — it is DERIVED from the caller's
// `cliName` as `${kind}_${cliName}`, matching how every shipped XSOAR field
// (custom or built-in) is named, and sidestepping a whole class of "forgot the
// prefix" bugs. `cliName` itself must be lowercase alphanumeric — the exact
// constraint XSOAR's own content validator enforces (Bleve DB key rules) — and
// must not collide with a reserved internal column name for that kind.
//
// DELETE is the one edge NOT independently confirmed by any of the sources
// above (neither the official generated client nor demisto-sdk's content-graph
// upload path exposes a field delete). `deleteFields` follows the SAME
// `POST /<resource>/delete` action-style convention already shipped and
// verified working in this app for lists (`/lists/delete`) and incident types
// (`/incidenttype/delete`) — see README "Scope & honesty" for the full caveat.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { readOptionalString, readStringArray, readBool, readString } from '../../lib/fields'
import { xsoarErrorMessage, type XsoarClient } from '../../lib/xsoar'

export type FieldKind = 'incident' | 'indicator'

/** XSOAR's own GroupFieldTypes enum: 0 = incident field, 1 = evidence (unused here), 2 = indicator field. */
export const FIELD_GROUP_BY_KIND: Record<FieldKind, number> = { incident: 0, indicator: 2 }

/** Field types accepted per kind (XSOAR rejects any value outside these — confirmed against the content validator). */
export const FIELD_TYPES_BY_KIND: Record<FieldKind, readonly string[]> = {
  incident: [
    'shortText', 'longText', 'boolean', 'singleSelect', 'multiSelect', 'date', 'user', 'role',
    'number', 'attachments', 'tagsSelect', 'internal', 'url', 'markdown', 'grid', 'timer', 'html',
  ],
  indicator: [
    'shortText', 'longText', 'boolean', 'singleSelect', 'multiSelect', 'date', 'user', 'role',
    'number', 'tagsSelect', 'url', 'markdown', 'grid', 'html',
  ],
}

/** Internal column names a cliName may never take (per kind) — XSOAR's own Bleve DB reserved-key list. */
export const RESERVED_CLI_NAMES_BY_KIND: Record<FieldKind, ReadonlySet<string>> = {
  incident: new Set([
    'id', 'shardid', 'modified', 'autime', 'account', 'type', 'rawtype', 'phase', 'rawphase',
    'name', 'rawname', 'status', 'reason', 'created', 'parent', 'occurred', 'duedate', 'reminder',
    'closed', 'sla',
  ]),
  indicator: new Set([
    'id', 'modified', 'type', 'rawname', 'name', 'createdtime', 'investigationids',
    'investigationscount', 'isioc', 'score', 'lastseen', 'lastreputationrun', 'firstseen',
    'calculatedtime', 'source', 'rawsource', 'manualscore', 'setby', 'manualsettime', 'comment',
    'modifiedtime', 'sourceinstances', 'sourcebrands', 'context', 'expiration', 'expirationstatus',
    'manuallyeditedfields', 'moduletofeedmap', 'isshared',
  ]),
}

/** A cliName must be lowercase letters/digits only — XSOAR's Bleve-backed field-key constraint. */
export const CLI_NAME_RE = /^[0-9a-z]+$/

export function fieldIdPrefix(kind: FieldKind): string {
  return `${kind}_`
}

/** Derive a field's server `id` from its kind + cliName — never authored by the user directly. */
export function buildFieldId(kind: FieldKind, cliName: string): string {
  return `${fieldIdPrefix(kind)}${cliName}`
}

/** Shape of a field returned by GET /incidentfields (both incident and indicator fields). */
export interface LiveField {
  id?: string
  cliName?: string
  name?: string
  type?: string
  group?: number
  description?: string
  required?: boolean
  associatedToAll?: boolean
  associatedTypes?: string[] | null
  system?: boolean
  locked?: boolean
  content?: boolean
  version?: number
}

/** True for a built-in / locked field XSOAR ships. The pipeline refuses to modify or delete these. */
export function isProtectedField(field: LiveField): boolean {
  return field.system === true || field.locked === true
}

/** A field's kind, keyed off its `id` prefix — the same discriminator demisto-sdk itself uses. */
export function fieldKindOf(field: LiveField): FieldKind | null {
  const id = (field.id ?? '').trim().toLowerCase()
  if (id.startsWith(fieldIdPrefix('incident'))) return 'incident'
  if (id.startsWith(fieldIdPrefix('indicator'))) return 'indicator'
  return null
}

/** Filter a full /incidentfields listing down to one kind. */
export function fieldsOfKind(fields: LiveField[], kind: FieldKind): LiveField[] {
  return fields.filter((f) => fieldKindOf(f) === kind)
}

export interface FieldSpec {
  sectionName: string
  /** Lowercase-alnum internal key; the server id is derived as `${kind}_${cliName}`. */
  cliName: string
  name: string
  type: string
  description?: string
  required: boolean
  associatedToAll: boolean
  /** Incident/indicator type names this field attaches to when not associated to all. */
  associatedTypes: string[]
}

/** Each canvas item describes one incident or indicator field (kind-agnostic extraction). */
export function extractFieldSpecs(canvas: CanvasSnapshot): FieldSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      cliName: readString(fields.cliName).toLowerCase(),
      name: readString(fields.name),
      type: readString(fields.type),
      description: readOptionalString(fields.description),
      required: readBool(fields.required, false),
      associatedToAll: readBool(fields.associatedToAll, true),
      associatedTypes: readStringArray(fields.associatedTypes),
    }
  })
}

/** GET every incident + indicator field; throws on a non-OK response. */
export async function listFields(client: XsoarClient): Promise<LiveField[]> {
  const res = await client.getJson<LiveField[]>('/incidentfields')
  if (!res.ok) throw new Error(`Failed to list fields: ${res.error ?? `HTTP ${res.status}`}`)
  return Array.isArray(res.value) ? res.value : []
}

/** XSOAR content-version convention: -1 marks a brand-new item and overrides an existing one on update. */
export const FIELD_VERSION = -1

/** Build the field body sent to /incidentfields/import for a create or update. */
export function buildFieldBody(kind: FieldKind, spec: FieldSpec, live: LiveField | null): Record<string, unknown> {
  return {
    id: buildFieldId(kind, spec.cliName),
    cliName: spec.cliName,
    name: spec.name,
    type: spec.type,
    group: FIELD_GROUP_BY_KIND[kind],
    description: spec.description ?? '',
    required: spec.required,
    associatedToAll: spec.associatedToAll,
    associatedTypes: spec.associatedToAll ? [] : spec.associatedTypes,
    version: typeof live?.version === 'number' ? live.version : FIELD_VERSION,
  }
}

/**
 * Upsert one field via POST /incidentfields/import (multipart; the file content
 * is JSON wrapping the field under "incidentFields" regardless of kind — see
 * module docstring). Throws on a non-OK response.
 */
export async function saveField(client: XsoarClient, body: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify({ incidentFields: [body] })
  const res = await client.requestMultipart('/incidentfields/import', {
    file: { filename: `${body.id}.json`, content: payload },
  })
  if (!res.ok) throw new Error(`Failed to save field "${body.id}": ${xsoarErrorMessage(res)}`)
}

/**
 * Delete one field by id via POST /incidentfields/delete, `{ id: [id] }`.
 *
 * BEST-EFFORT / INFERRED CONVENTION: unlike list/save (confirmed against the
 * official generated client + demisto-sdk source), no source independently
 * confirms this exact delete contract. It follows the same
 * `POST /<resource>/delete` action-family already shipped and working in this
 * app for lists and incident types, and fields are a bulk collection endpoint
 * (no per-item GET) — consistent with an array-bodied delete. A 404 is treated
 * as already-deleted (success); any other failure is surfaced verbatim so a
 * rollback never silently reports success without actually removing the field.
 */
export async function deleteField(client: XsoarClient, id: string): Promise<void> {
  const res = await client.request('POST', '/incidentfields/delete', { body: { id: [id] } })
  if (res.status !== 404 && !res.ok) {
    throw new Error(`Failed to delete field "${id}": ${xsoarErrorMessage(res)}`)
  }
}
