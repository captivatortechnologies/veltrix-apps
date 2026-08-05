// Shared descriptor + body builder for the Custom Fields (CEF) config type.
//
// REST shape follows /rest/cef (docs.splunk.com SOAR PlatformAPI — CEF
// endpoints): name, data_type (array of strings). The response also carries a
// read-only `type` ("default"|"custom") that this type never sends and never
// compares (SOAR's own built-in CEF fields report type:"default" and are never
// declared here). GET (with _filter_name/_filter_type)/POST/POST-<id>/DELETE
// confirmed; verify against a live SOAR instance.

import type { RecordDescriptor, RecordSpec } from '../../lib/soarRecordEntities'
import { readStringList } from '../../lib/soarCommon'

export const CEF: RecordDescriptor = {
  resource: 'cef',
  kind: 'custom field',
  Kind: 'Custom Field',
  identityKey: 'name',
}

export function buildCefRecord(fields: Record<string, unknown>): RecordSpec {
  const name = String(fields.name ?? '').trim()
  if (!name) return { id: '', body: null, error: null }

  const dataType = readStringList(fields.data_type)
  if (dataType.length === 0) {
    return { id: name, body: null, error: 'At least one data type is required.' }
  }

  return { id: name, body: { name, data_type: dataType }, error: null }
}
