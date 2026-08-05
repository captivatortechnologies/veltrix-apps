// Shared descriptor + body builder for the Severities config type.
//
// REST shape follows /rest/severity (docs.splunk.com SOAR PlatformAPI —
// RESTSeverity): name (<=20 chars, [A-Za-z0-9_-]), color (fixed palette),
// is_default. GET/POST/DELETE confirmed; verify against a live SOAR instance.

import type { RecordDescriptor, RecordSpec } from '../../lib/soarRecordEntities'
import { normalizeBool } from '../../lib/soarCommon'

export const SEVERITY: RecordDescriptor = {
  resource: 'severity',
  kind: 'severity',
  Kind: 'Severity',
  identityKey: 'name',
}

export const NAME_RE = /^[A-Za-z0-9_-]+$/
export const MAX_NAME_LENGTH = 20

export const SEVERITY_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'light_blue',
  'blue',
  'purple',
  'light_grey',
  'dark_grey',
  'pink',
] as const

export function buildSeverityRecord(fields: Record<string, unknown>): RecordSpec {
  const name = String(fields.name ?? '').trim()
  if (!name) return { id: '', body: null, error: null }

  if (!NAME_RE.test(name) || name.length > MAX_NAME_LENGTH) {
    return { id: name, body: null, error: `Name must be ${MAX_NAME_LENGTH} characters or fewer, letters/numbers/dash/underscore only.` }
  }

  const color = String(fields.color ?? '').trim()
  if (!SEVERITY_COLORS.includes(color as (typeof SEVERITY_COLORS)[number])) {
    return { id: name, body: null, error: `Color must be one of ${SEVERITY_COLORS.join(', ')} (got "${color}").` }
  }

  return {
    id: name,
    body: { name, color, is_default: normalizeBool(fields.is_default) },
    error: null,
  }
}
