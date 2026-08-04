// Cribl Notifications config type — alert rules that fire on a condition
// (high-volume, no-data, persistent-queue-usage, a saved Search query, ...)
// and route to one or more Notification Targets, over /api/v1/notifications.
// Shares the generic record CRUD engine in lib/criblRecordEntities.
//
// A Notification is a flat named record:
//   { id, condition, disabled, targets: [...], conf: {...}, metadata: [...], group }
// Unlike Sources/Destinations/Collectors, this collection is NOT Worker-Group-
// scoped as a PATH segment (`groupScoped: false`) — `group` is instead a
// genuine BODY field (which Worker Group/Fleet the condition applies to,
// left blank to apply tenant-wide). `conf`'s shape depends on `condition` (see
// the canvas help text), so it is authored as JSON like Pipelines' Function
// conf. Verify against a live Cribl.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'
import { readStringList } from '../../lib/criblCommon'

export const NOTIFICATION: RecordDescriptor = {
  resource: 'notifications',
  kind: 'notification',
  Kind: 'Notification',
  groupScoped: false,
}

export function buildNotificationRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  const condition = String(fields.condition ?? '').trim()
  if (!condition) return { id, body: null, error: 'condition is required — what triggers this notification.' }

  const body: Record<string, unknown> = { id, condition, disabled: Boolean(fields.disabled) }

  const targets = readStringList(fields.targets)
  if (targets.length > 0) body.targets = targets

  const group = String(fields.group ?? '').trim()
  if (group) body.group = group

  const confText = String(fields.conf ?? '').trim()
  if (confText) {
    let parsed: unknown
    try {
      parsed = JSON.parse(confText)
    } catch (e) {
      return { id, body: null, error: `conf is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { id, body: null, error: 'conf must be a JSON object.' }
    }
    body.conf = parsed
  }

  const metadataText = String(fields.metadata ?? '').trim()
  if (metadataText) {
    let parsed: unknown
    try {
      parsed = JSON.parse(metadataText)
    } catch (e) {
      return { id, body: null, error: `metadata is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
    }
    if (!Array.isArray(parsed)) return { id, body: null, error: 'metadata must be a JSON array of { "name", "value" } objects.' }
    body.metadata = parsed
  }

  return { id, body, error: null }
}
