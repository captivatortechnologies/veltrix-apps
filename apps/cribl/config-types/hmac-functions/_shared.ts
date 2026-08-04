// Cribl HMAC Functions config type — reusable request-signing definitions
// (used to sign outbound Destination requests) over
// /api/v1/m/<group>/lib/hmac-functions. Shares the generic record CRUD engine
// in lib/criblRecordEntities. An HmacFunction is a flat named record:
//   { id, lib, headerName, headerExpression, stringBuilders, stringDelim, description }
// No secret material lives on this resource itself — `headerExpression`
// typically references a secret key held elsewhere (e.g. a Global Variable or
// a `${{secret:<name>}}` reference), so nothing here is write-only.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'
import { readStringList } from '../../lib/criblCommon'

export const HMAC_FUNCTION: RecordDescriptor = {
  resource: 'lib/hmac-functions',
  kind: 'HMAC function',
  Kind: 'HMAC Function',
}

export function buildHmacFunctionRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  const headerName = String(fields.header_name ?? '').trim()
  if (!headerName) return { id, body: null, error: 'header_name is required — the HTTP header to carry the signature.' }
  const headerExpression = String(fields.header_expression ?? '').trim()
  if (!headerExpression) return { id, body: null, error: 'header_expression is required — the JavaScript expression that computes the signature.' }
  const stringBuilders = readStringList(fields.string_builders)
  if (stringBuilders.length === 0) return { id, body: null, error: 'string_builders is required — at least one expression to build the signature string.' }

  const body: Record<string, unknown> = {
    id,
    lib: String(fields.lib ?? 'custom').trim() || 'custom',
    headerName,
    headerExpression,
    stringBuilders,
  }
  const stringDelim = String(fields.string_delim ?? '')
  if (stringDelim) body.stringDelim = stringDelim
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description

  return { id, body, error: null }
}
