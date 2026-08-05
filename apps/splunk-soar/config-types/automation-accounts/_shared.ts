// Shared descriptor + body builder for the Automation Accounts config type.
//
// REST shape follows /rest/ph_user (docs.splunk.com SOAR PlatformAPI — User
// Management endpoints): username, type ("automation" — fixed here), roles,
// allowed_ips, default_label, default_tenant_id, email, title, location,
// time_zone. `password` is REQUIRED only for type:"normal" (local human
// accounts) and OPTIONAL for "automation" — this type never sends it, by
// design (see README Coverage). GET (excludes automation users by default —
// `include_automation=true` is required to see them)/POST/POST-<id>/DELETE
// confirmed; verify against a live SOAR instance.

import type { RecordDescriptor, RecordSpec } from '../../lib/soarRecordEntities'
import { readStringList, readNumber } from '../../lib/soarCommon'

export const AUTOMATION_ACCOUNT: RecordDescriptor = {
  resource: 'ph_user',
  kind: 'automation account',
  Kind: 'Automation Account',
  identityKey: 'username',
  listParams: '&include_automation=true',
}

export function buildAccountRecord(fields: Record<string, unknown>): RecordSpec {
  const username = String(fields.username ?? '').trim()
  if (!username) return { id: '', body: null, error: null }

  const body: Record<string, unknown> = {
    username,
    type: 'automation',
    roles: readStringList(fields.roles),
    allowed_ips: readStringList(fields.allowed_ips),
  }

  const email = String(fields.email ?? '').trim()
  if (email) body.email = email
  const defaultLabel = String(fields.default_label ?? '').trim()
  if (defaultLabel) body.default_label = defaultLabel
  const title = String(fields.title ?? '').trim()
  if (title) body.title = title
  const location = String(fields.location ?? '').trim()
  if (location) body.location = location
  const timeZone = String(fields.time_zone ?? '').trim()
  if (timeZone) body.time_zone = timeZone
  const defaultTenantId = fields.default_tenant_id
  if (defaultTenantId !== undefined && defaultTenantId !== '') {
    body.default_tenant_id = readNumber(defaultTenantId, 0)
  }

  return { id: username, body, error: null }
}
