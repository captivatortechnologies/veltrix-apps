// Shared helpers for the Cribl Pipelines config type (deploy + rollback + drift +
// validate).
//
// Cribl pipeline shape (over /api/v1[/m/<group>]/pipelines):
//   { id: "myPipeline", conf: { asyncFuncTimeout?, functions: [ ... ], groups? } }
// where each function is { id, filter?, disabled?, conf?, final?, description? }.
// A list response wraps the rows: { items: [...], count: N }. Verify against a
// live Cribl.

import { DEFAULT_WORKER_GROUP } from '../../lib/criblApi'

/** One Function in a pipeline's Function chain. */
export interface CriblFunction {
  id?: string
  filter?: string
  disabled?: boolean
  final?: boolean
  description?: string
  conf?: Record<string, unknown>
  [key: string]: unknown
}

/** A pipeline's `conf` block — the Function chain plus pipeline-level options. */
export interface CriblPipelineConf {
  asyncFuncTimeout?: number
  functions: CriblFunction[]
  groups?: Record<string, unknown>
  [key: string]: unknown
}

/** One Cribl pipeline as returned by the REST API. */
export interface CriblPipeline {
  id?: string
  conf?: CriblPipelineConf
  [key: string]: unknown
}

/** Cribl pipeline ids: letters, digits, underscore and hyphen (no spaces). */
export const PIPELINE_ID_RE = /^[A-Za-z0-9_-]+$/

export interface ParsedConf {
  conf: CriblPipelineConf | null
  error: string | null
}

/**
 * Parse the `conf` textarea (JSON) into a pipeline conf. Accepts either a full
 * conf object ({ functions: [...] }) or a bare Function array ([ ... ]), which is
 * wrapped into { functions: [...] }. Guarantees a `functions` array on success.
 */
export function parseConf(raw: unknown): ParsedConf {
  const text = String(raw ?? '').trim()
  if (!text) return { conf: null, error: 'conf is empty — provide the pipeline configuration as JSON.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { conf: null, error: `conf is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }

  if (Array.isArray(parsed)) {
    return { conf: { functions: parsed as CriblFunction[] }, error: null }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { conf: null, error: 'conf must be a JSON object ({ functions: [...] }) or a JSON array of functions.' }
  }

  const obj = parsed as Record<string, unknown>
  const functions = obj.functions
  if (!Array.isArray(functions)) {
    return { conf: null, error: 'conf must contain a "functions" array.' }
  }
  return { conf: { ...(obj as CriblPipelineConf), functions: functions as CriblFunction[] }, error: null }
}

/**
 * Resolve the target Worker Group / Edge Fleet for an item:
 *   item field `worker_group` → settings.default_worker_group → "default".
 * An explicitly blank setting yields "" (single-instance / non-distributed).
 */
export function resolveWorkerGroup(fields: Record<string, unknown>, settings: Record<string, unknown>): string {
  const fromField = String(fields.worker_group ?? '').trim()
  if (fromField) return fromField
  const fromSetting = settings?.default_worker_group
  if (typeof fromSetting === 'string') return fromSetting.trim()
  return DEFAULT_WORKER_GROUP
}

/** Unwrap Cribl's `{ items: [...] }` list envelope (or a bare array) into rows. */
export function pipelinesFromList(list: unknown): CriblPipeline[] {
  if (Array.isArray(list)) return list as CriblPipeline[]
  if (list && typeof list === 'object' && Array.isArray((list as { items?: unknown }).items)) {
    return (list as { items: CriblPipeline[] }).items
  }
  return []
}

/** Find a live pipeline by its id (the stable identity). */
export function findPipeline(pipelines: CriblPipeline[], id: string): CriblPipeline | null {
  const target = id.trim()
  if (!target) return null
  return pipelines.find((p) => String(p.id ?? '').trim() === target) ?? null
}

/** Build the pipeline request body from a resolved id + conf. */
export function buildPipelineBody(id: string, conf: CriblPipelineConf): CriblPipeline {
  return { id: id.trim(), conf }
}

/** Stable, key-sorted JSON of a value — for order-insensitive drift comparison. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v as object)) return null
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(sort)
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sort((v as Record<string, unknown>)[k])
        return acc
      }, {})
  }
  return JSON.stringify(sort(value))
}
