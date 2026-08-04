// Cribl Grok Patterns config type — reusable Grok pattern files over
// /api/v1/m/<group>/lib/grok. Shares the generic record CRUD engine in
// lib/criblRecordEntities. A GrokFile is a flat named record: { id, content }
// — `size` is server-computed and read-only, so it is never sent.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'

export const GROK: RecordDescriptor = {
  resource: 'lib/grok',
  kind: 'Grok pattern file',
  Kind: 'Grok Pattern File',
}

export function buildGrokRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  const content = String(fields.content ?? '')
  if (!content.trim()) return { id, body: null, error: 'content is empty — provide the Grok pattern definitions.' }

  return { id, body: { id, content }, error: null }
}
