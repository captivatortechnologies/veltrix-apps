// Cribl Database Connections config type — reusable JDBC-style connections
// (used by the Database Collector/Destination) over
// /api/v1/m/<group>/lib/database-connections. Shares the generic record CRUD
// engine in lib/criblRecordEntities.
//
// ⚠ WRITE-ONLY SECRETS: `connectionString`, `password` and `configObj` can
// embed credentials and are never echoed back by Cribl, so each is sent ONLY
// when its canvas field is non-blank, is never captured into rollbackData, and
// is never drift-checked (see lib/criblRecordEntities' `sensitiveKeys`).
// Cribl's own documented convention for referencing a stored Secret instead of
// a literal is `${{secret:<name>}}` — prefer `creds_secrets` / `text_secret`
// (plain reference NAMES, not secret material) where the auth type allows it.
// Same trade-off as apps/cisco-ise's internal-users write-only password.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'

export const DATABASE_CONNECTION: RecordDescriptor = {
  resource: 'lib/database-connections',
  kind: 'database connection',
  Kind: 'Database Connection',
  sensitiveKeys: ['connectionString', 'password', 'configObj'],
}

export const DATABASE_TYPES = ['mysql', 'oracle', 'postgres', 'sqlserver'] as const

export function buildDatabaseConnectionRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  const databaseType = String(fields.database_type ?? '').trim()
  if (!databaseType) return { id, body: null, error: 'database_type is required.' }
  if (!(DATABASE_TYPES as readonly string[]).includes(databaseType)) {
    return { id, body: null, error: `database_type "${databaseType}" must be one of: ${DATABASE_TYPES.join(', ')}.` }
  }
  const authType = String(fields.auth_type ?? '').trim()
  if (!authType) return { id, body: null, error: 'auth_type is required.' }
  const description = String(fields.description ?? '').trim()
  if (!description) return { id, body: null, error: 'description is required.' }

  const body: Record<string, unknown> = { id, databaseType, authType, description }

  const connectionString = String(fields.connection_string ?? '')
  if (connectionString) body.connectionString = connectionString
  const password = String(fields.password ?? '')
  if (password) body.password = password
  const user = String(fields.user ?? '').trim()
  if (user) body.user = user
  const credsSecrets = String(fields.creds_secrets ?? '').trim()
  if (credsSecrets) body.credsSecrets = credsSecrets
  const textSecret = String(fields.text_secret ?? '').trim()
  if (textSecret) body.textSecret = textSecret
  const configObjText = String(fields.config_obj ?? '').trim()
  if (configObjText) body.configObj = configObjText
  const tags = String(fields.tags ?? '').trim()
  if (tags) body.tags = tags

  const connectionTimeout = fields.connection_timeout
  if (connectionTimeout !== undefined && connectionTimeout !== null && connectionTimeout !== '') {
    body.connectionTimeout = Number(connectionTimeout)
  }
  const requestTimeout = fields.request_timeout
  if (requestTimeout !== undefined && requestTimeout !== null && requestTimeout !== '') {
    body.requestTimeout = Number(requestTimeout)
  }

  return { id, body, error: null }
}
