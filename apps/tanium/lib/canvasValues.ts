// Generic canvas-value coercion helpers shared across Tanium config types
// (computer-groups' manual host/IP lists, sensors' multi-platform queries).
// Not resource-specific — pure parsing of the loosely-typed values a canvas
// field hands a handler.

/** Read a canvas value that may be a `tags`/`multiselect` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim())).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  }
  return []
}

/** Read a canvas `keyvalue` field as a flat string map, dropping blank keys. */
export function keyValueMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const k = key.trim()
    if (k) out[k] = typeof raw === 'string' ? raw : String(raw ?? '')
  }
  return out
}
