// Cribl Collectors config type — scheduled/ad hoc data-collection jobs over
// /api/v1/m/<group>/lib/jobs. Shares the generic record CRUD engine in
// lib/criblRecordEntities.
//
// A Collector's real shape is a discriminated union across ~9 backends (REST,
// S3, Azure Blob, Database, GCS, Splunk, Cribl Lake, Script, Health Check),
// each nesting its own settings under `collector.conf`, alongside a common
// `input` (pipeline/output routing) and `schedule` (cron) block:
//   { id, type: "collection", collector: { type, conf }, input: {...}, schedule: {...}, ttl, ... }
// Modeling every backend's settings as typed fields would mean re-deriving
// Sources'-scale, per-type schemas; instead this config type follows the SAME
// precedent as this app's own Pipelines (whose Function chain is JSON) and
// Routes (whose ordered table is JSON): identity (`id`) is typed, everything
// else is authored as one JSON block matching the documented InputCollector
// body. `type: "collection"` is auto-filled when omitted, since it is the only
// value Cribl accepts at the top level.
//
// ⚠ Some collector backends' `collector.conf` embeds credentials (e.g. REST's
// `password`/`token`) inside this JSON block — the same accepted trade-off
// this app already makes for Sources'/Destinations' `conf` (see
// lib/criblSystemEntities.ts). Verify against a live Cribl.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'

export const COLLECTOR: RecordDescriptor = {
  resource: 'lib/jobs',
  kind: 'collector',
  Kind: 'Collector',
}

export interface ParsedCollectorConf {
  conf: Record<string, unknown> | null
  error: string | null
}

/** Parse the `conf` textarea (JSON) into the collector body (everything but `id`). */
export function parseCollectorConf(raw: unknown): ParsedCollectorConf {
  const text = String(raw ?? '').trim()
  if (!text) return { conf: null, error: 'conf is empty — provide the collector configuration as JSON.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { conf: null, error: `conf is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { conf: null, error: 'conf must be a JSON object.' }
  }
  const obj = parsed as Record<string, unknown>
  const collector = obj.collector
  if (!collector || typeof collector !== 'object' || Array.isArray(collector) || !String((collector as Record<string, unknown>).type ?? '').trim()) {
    return { conf: null, error: 'conf.collector.type is required (the collector backend, e.g. rest, s3, database, azureblob).' }
  }
  return { conf: { type: 'collection', ...obj }, error: null }
}

export function buildCollectorRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }

  const { conf, error } = parseCollectorConf(fields.conf)
  if (error || !conf) return { id, body: null, error: error ?? 'invalid conf' }

  return { id, body: { id, ...conf }, error: null }
}
