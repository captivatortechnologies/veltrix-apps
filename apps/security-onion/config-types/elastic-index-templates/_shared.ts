// Shared helpers for the Elasticsearch Index Templates config type.

/** A `tags` canvas field arrives as a string[] (already split) or a raw comma/newline
 *  string, depending on how the canvas serialized it — normalize to a deduped list. */
export function parseStringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map((v) => String(v)) : String(value ?? '').split(/[\r\n,]+/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const e = entry.trim()
    if (!e || seen.has(e)) continue
    seen.add(e)
    out.push(e)
  }
  return out
}

/**
 * Build a PUT /_index_template/<name> body from canvas fields. Matches the
 * request shape documented at
 * https://www.elastic.co/guide/en/elasticsearch/reference/current/indices-put-template.html
 * — `index_patterns` (required), optional `priority`/`composed_of`, and
 * `template.settings` using the flat dotted-key form shown in that same
 * reference (`{"settings": {"number_of_shards": 2}}`), so `index.lifecycle.name`
 * (the ILM policy to attach) is set the same way rather than as a nested object.
 */
export function buildIndexTemplateBody(fields: Record<string, unknown>): Record<string, unknown> {
  const indexPatterns = parseStringList(fields.indexPatterns)
  const composedOf = parseStringList(fields.composedOf)
  const priorityRaw = fields.priority
  const hasPriority = priorityRaw !== undefined && priorityRaw !== null && String(priorityRaw).trim() !== ''
  const ilmPolicyName = String(fields.ilmPolicyName ?? '').trim()

  const settings: Record<string, unknown> = {
    number_of_shards: Number(fields.numberOfShards),
    number_of_replicas: Number(fields.numberOfReplicas),
  }
  if (ilmPolicyName) settings['index.lifecycle.name'] = ilmPolicyName

  const body: Record<string, unknown> = {
    index_patterns: indexPatterns,
    template: { settings },
  }
  if (hasPriority) body.priority = Number(priorityRaw)
  if (composedOf.length > 0) body.composed_of = composedOf
  return body
}

/** GET /_index_template/<name> response envelope (Elasticsearch's standard
 *  multi-resource wrapper — the same shape GET /_component_template returns). */
export interface IndexTemplateGetResponse {
  index_templates?: Array<{ name: string; index_template?: Record<string, unknown> }>
}
