// Shared descriptor + body builder for the Container Statuses config type.
//
// REST shape follows /rest/container_status (docs.splunk.com SOAR PlatformAPI —
// RESTStatus): name (<=20 chars, [A-Za-z0-9_-]), status_type (new|open|resolved),
// is_default. Max 30 total statuses; at least one active per category; the
// built-in "New"/"Open"/"Closed" labels cannot be renamed (SOAR itself enforces
// this — surfaced as a clear deploy failure, not pre-validated here). GET/POST/
// DELETE confirmed; verify against a live SOAR instance.

import type { RecordDescriptor, RecordSpec } from '../../lib/soarRecordEntities'
import { normalizeBool } from '../../lib/soarCommon'

export const CONTAINER_STATUS: RecordDescriptor = {
  resource: 'container_status',
  kind: 'status',
  Kind: 'Status',
  identityKey: 'name',
}

export const NAME_RE = /^[A-Za-z0-9_-]+$/
export const MAX_NAME_LENGTH = 20
export const STATUS_TYPES = ['new', 'open', 'resolved'] as const

export function buildStatusRecord(fields: Record<string, unknown>): RecordSpec {
  const name = String(fields.name ?? '').trim()
  if (!name) return { id: '', body: null, error: null }

  if (!NAME_RE.test(name) || name.length > MAX_NAME_LENGTH) {
    return { id: name, body: null, error: `Name must be ${MAX_NAME_LENGTH} characters or fewer, letters/numbers/dash/underscore only.` }
  }

  const statusType = String(fields.status_type ?? '').trim().toLowerCase()
  if (!STATUS_TYPES.includes(statusType as (typeof STATUS_TYPES)[number])) {
    return { id: name, body: null, error: `Category must be one of ${STATUS_TYPES.join(', ')} (got "${statusType}").` }
  }

  return {
    id: name,
    body: { name, status_type: statusType, is_default: normalizeBool(fields.is_default) },
    error: null,
  }
}
