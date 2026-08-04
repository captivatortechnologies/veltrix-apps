// Cribl Lookups config type — CSV/MMDB lookup tables over
// /api/v1/m/<group>/system/lookups. Shares the generic record CRUD engine in
// lib/criblRecordEntities (upsert by id / rollback / drift), since a Lookup is
// a flat named record — { id, content, description, mode, tags } — with no
// `type` discriminator.
//
// NOTE: field names + the id pattern (must match the underlying lookup
// filename, e.g. "countries.csv") follow the documented LookupFile schema.
// Verify against a live Cribl.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'
import { resolveWorkerGroup } from '../../lib/criblCommon'

export const LOOKUP: RecordDescriptor = {
  resource: 'system/lookups',
  kind: 'lookup',
  Kind: 'Lookup',
}

/** Lookup filenames: word-start, then word/space/hyphen, optional csv/gz/csv.gz/mmdb extension. */
export const LOOKUP_ID_RE = /^\w[\w -]+(?:\.csv|\.gz|\.csv\.gz|\.mmdb)?$/

export function buildLookupRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  if (!LOOKUP_ID_RE.test(id)) {
    return { id, body: null, error: `Lookup ID "${id}" must look like a filename (letters, digits, space, underscore, hyphen; optional .csv/.gz/.csv.gz/.mmdb extension).` }
  }
  const content = String(fields.content ?? '')
  if (!content.trim()) return { id, body: null, error: 'content is empty — provide the lookup table data.' }

  const body: Record<string, unknown> = {
    id,
    content,
    mode: String(fields.mode ?? 'memory').trim() || 'memory',
  }
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  const tags = String(fields.tags ?? '').trim()
  if (tags) body.tags = tags

  return { id, body, error: null }
}

/** Worker Group resolution shared with validate/deploy/drift. */
export { resolveWorkerGroup }
