// Shared helpers for the Graylog Pipeline Connections config type (validate +
// deploy + rollback + drift). Shapes follow the Graylog REST API
// (/api/system/pipelines/connections):
//   • POST body (to_stream) = PipelineConnections { stream_id, pipeline_ids }
//   • GET  response         = PipelineConnections { id, stream_id, pipeline_ids }
// Source: org.graylog.plugins.pipelineprocessor.rest.PipelineConnectionsResource
// (@ 6.1) — `to_stream` REPLACES the whole set of pipelines wired to one stream
// (the same "whole-value replace, per identity" shape streams' index_set_id
// resolution and index-sets' rotation strategy use), so this config type models
// ONE item PER STREAM. `stream_id`/`pipeline_ids` are resolved from friendlier
// stream/pipeline TITLES at deploy time (the same friendliness streams'
// `resolveIndexSetId` and lookup-tables' cache/adapter name resolution provide).

import { asString } from '../../lib/coerce'
import { getJson } from '../../lib/graylogApi'

/** A stream as returned by GET /api/streams (only the fields used here). */
interface StreamRef {
  id?: string
  title?: string
}
interface StreamListResponse {
  streams?: StreamRef[]
}

/** A pipeline as returned by GET /api/system/pipelines/pipeline (only the fields used here). */
interface PipelineRef {
  id?: string
  title?: string
}

/** One stream's pipeline connections, as returned by the connections API. */
export interface GraylogPipelineConnections {
  id?: string
  stream_id?: string
  pipeline_ids?: string[]
  [key: string]: unknown
}

/** Resolve a stream title to its id via GET /api/streams. Returns '' if not found. */
export async function resolveStreamId(base: string, headers: Record<string, string>, title: string): Promise<string> {
  const t = asString(title)
  if (!t) return ''
  try {
    const res = await getJson<StreamListResponse | StreamRef[]>(`${base}/api/streams`, headers)
    const streams = Array.isArray(res) ? res : (res.streams ?? [])
    return asString(streams.find((s) => asString(s.title) === t)?.id)
  } catch {
    return ''
  }
}

/**
 * Resolve a list of pipeline titles to ids via GET /api/system/pipelines/pipeline.
 * Titles that don't match a live pipeline are reported in `missing` rather than
 * silently dropped, so deploy can fail loudly instead of connecting a smaller
 * set than declared.
 */
export async function resolvePipelineIds(
  base: string,
  headers: Record<string, string>,
  titles: string[],
): Promise<{ ids: string[]; missing: string[] }> {
  let pipelines: PipelineRef[] = []
  try {
    const res = await getJson<unknown>(`${base}/api/system/pipelines/pipeline`, headers)
    pipelines = Array.isArray(res) ? (res as PipelineRef[]) : []
  } catch {
    pipelines = []
  }
  const ids: string[] = []
  const missing: string[] = []
  for (const title of titles) {
    const t = asString(title)
    if (!t) continue
    const match = pipelines.find((p) => asString(p.title) === t)
    if (match?.id) ids.push(match.id)
    else missing.push(t)
  }
  return { ids, missing }
}

export interface ParsedTitleList {
  titles: string[]
  error?: string
}

/**
 * Parse the canvas `pipeline_titles` field: a JSON array of pipeline title
 * strings. An empty/blank value is a valid empty list (disconnect all
 * pipelines from the stream).
 */
export function parsePipelineTitles(value: unknown): ParsedTitleList {
  if (value == null || value === '') return { titles: [] }
  let raw: unknown = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return { titles: [] }
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return { titles: [], error: `pipeline_titles is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
    }
  }
  if (!Array.isArray(raw)) return { titles: [], error: 'pipeline_titles must be a JSON array of pipeline title strings' }
  return { titles: raw.map((v) => String(v)) }
}

/** Find a live stream's connections by stream id. */
export function findConnectionsByStreamId(
  all: GraylogPipelineConnections[],
  streamId: string,
): GraylogPipelineConnections | null {
  const id = asString(streamId)
  if (!id) return null
  return all.find((c) => asString(c.stream_id) === id) ?? null
}
