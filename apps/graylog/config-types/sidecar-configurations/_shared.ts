// Shared helpers for the Graylog Sidecar Configurations config type (validate
// + deploy + rollback + drift). Shapes follow the Graylog REST API
// (/api/sidecar/configurations):
//   • POST/PUT body  = Configuration { name, collector_id, color, template, tags }
//   • GET  (list)    = ConfigurationListResponse { configurations: [ConfigurationSummary] }
//                       — a SUMMARY only (no `template`); the full Configuration
//                       (with template) requires GET .../{id}.
//   • GET  (by id)   = Configuration (full, with template)
// `collector_id` is resolved from a friendlier `collector_name` (+ optional
// `collector_os` to disambiguate — a collector name may repeat across
// operating systems, see the Sidecar Collectors config type) at deploy time.
// Source: org.graylog.plugins.sidecar.rest.resources.ConfigurationResource,
// org.graylog.plugins.sidecar.rest.models.{Configuration,ConfigurationSummary} (@ 6.1).

import { asString } from '../../lib/coerce'
import { getJson } from '../../lib/graylogApi'

/** A collector as returned by GET /api/sidecar/collectors (only the fields used here). */
interface CollectorRef {
  id?: string
  name?: string
  node_operating_system?: string
}
interface CollectorListResponse {
  collectors?: CollectorRef[]
}

/** One configuration SUMMARY as returned by GET /api/sidecar/configurations (ConfigurationSummary). */
export interface GraylogSidecarConfigSummary {
  id?: string
  name?: string
  collector_id?: string
  color?: string
  tags?: string[]
  [key: string]: unknown
}

/** GET /api/sidecar/configurations envelope: `{ configurations: [...] }`. */
interface ConfigurationListResponse {
  configurations?: GraylogSidecarConfigSummary[]
}

/** The FULL configuration as returned by GET /api/sidecar/configurations/{id} (Configuration). */
export interface GraylogSidecarConfig extends GraylogSidecarConfigSummary {
  template?: string
}

/** Body sent to POST /api/sidecar/configurations and PUT /api/sidecar/configurations/{id}. */
export interface SidecarConfigBody {
  name: string
  collector_id: string
  color: string
  template: string
  tags: string[]
}

/** Unwrap GET /api/sidecar/configurations into a flat array of summaries. */
export function sidecarConfigSummariesFromList(list: unknown): GraylogSidecarConfigSummary[] {
  if (Array.isArray(list)) return list as GraylogSidecarConfigSummary[]
  const configs = (list as ConfigurationListResponse | null)?.configurations
  return Array.isArray(configs) ? configs : []
}

/** Find a live configuration summary by name (the stable identity used for upsert + drift). */
export function findSidecarConfigSummary(configs: GraylogSidecarConfigSummary[], name: string): GraylogSidecarConfigSummary | null {
  const n = asString(name)
  if (!n) return null
  return configs.find((c) => asString(c.name) === n) ?? null
}

/**
 * Resolve a collector name (+ optional OS) to its id via GET
 * /api/sidecar/collectors. Returns '' if no (unambiguous) match is found.
 */
export async function resolveCollectorId(
  base: string,
  headers: Record<string, string>,
  collectorName: string,
  collectorOs: string,
): Promise<string> {
  const name = asString(collectorName)
  if (!name) return ''
  try {
    const res = await getJson<CollectorListResponse>(`${base}/api/sidecar/collectors`, headers)
    const collectors = res.collectors ?? []
    const os = asString(collectorOs).toLowerCase()
    const matches = collectors.filter((c) => asString(c.name) === name && (!os || asString(c.node_operating_system).toLowerCase() === os))
    return asString(matches[0]?.id)
  } catch {
    return ''
  }
}

/** Parse the canvas `tags` field: a JSON array of tag strings. Blank is a valid empty set. */
export function parseSidecarTags(value: unknown): { tags: string[]; error?: string } {
  if (value == null || value === '') return { tags: [] }
  let raw: unknown = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return { tags: [] }
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return { tags: [], error: `tags is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
    }
  }
  if (!Array.isArray(raw)) return { tags: [], error: 'tags must be a JSON array of tag strings' }
  return { tags: raw.map((v) => String(v)) }
}

/** Build the Configuration body from canvas fields + a resolved collector id. */
export function buildSidecarConfigBody(fields: Record<string, unknown>, collectorId: string): { body?: SidecarConfigBody; error?: string } {
  const { tags, error } = parseSidecarTags(fields.tags)
  if (error) return { error }
  return {
    body: {
      name: asString(fields.name),
      collector_id: collectorId,
      color: asString(fields.color) || '#FF3B2F',
      template: String(fields.template ?? ''),
      tags,
    },
  }
}

/** Build a restore body from a live (full) configuration (rollback). */
export function bodyFromLiveSidecarConfig(config: GraylogSidecarConfig): SidecarConfigBody {
  return {
    name: asString(config.name),
    collector_id: asString(config.collector_id),
    color: asString(config.color) || '#FF3B2F',
    template: String(config.template ?? ''),
    tags: Array.isArray(config.tags) ? config.tags : [],
  }
}
