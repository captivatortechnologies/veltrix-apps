// Shared helpers for the Container Labels config type (deploy + rollback + drift).
//
// REST shape follows /rest/system_settings/events + /rest/system_settings/labels
// (docs.splunk.com SOAR PlatformAPI — System Settings endpoints):
//   read : GET  /rest/system_settings/labels                            (GET-only)
//   add  : POST /rest/system_settings/events { add_label: true, label_name }
//   drop : POST /rest/system_settings/events { remove_label: true, label_name }
// There is no rename and no dedicated per-label GET/DELETE — add/remove by
// name only. Both mutations are POSTs (not the generic DELETE verb), so — unlike
// every other type in this app — they are NOT confirmed to be restricted to a
// user-authenticated credential; verify against a live instance.

export function buildLabelName(fields: Record<string, unknown>): string {
  return String(fields.name ?? '').trim()
}

/**
 * Parse the `/rest/system_settings/labels` response into a flat list of names.
 * The exact wire shape isn't fully documented — defensively accepts a bare
 * array of strings, a `{ labels: [...] }` wrapper, or the platform's generic
 * `{ data: [...] }` list envelope. Verify against a live instance.
 */
export function parseLabelList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => (typeof v === 'string' ? v : String((v as { name?: unknown })?.name ?? v)))
  if (raw && typeof raw === 'object') {
    const obj = raw as { labels?: unknown; data?: unknown }
    if (Array.isArray(obj.labels)) return parseLabelList(obj.labels)
    if (Array.isArray(obj.data)) return parseLabelList(obj.data)
  }
  return []
}
