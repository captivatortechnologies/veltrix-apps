// Cribl Worker Group Settings config type — the "worker-groups config" surface:
// per-group system settings (API/TLS/security/PII/backups/rollback/shutdown/
// worker sizing) over /api/v1/m/<group>/system/settings/conf.
//
// IMPORTANT — this is a SINGLETON per Worker Group (GET+PATCH only; there is
// no POST/DELETE), so this config type follows the same one-item-per-group
// shape as this app's own Routes config type: identity = the group id, payload
// = the settings object to PATCH. Users declare only the fields they want to
// enforce (a PARTIAL object, e.g. { "tls": { "minVersion": "TLSv1.2" } }) —
// Cribl's PATCH here is scoped to exactly the sub-object you send, so this
// does NOT require (or want) the full ~100-field settings object every time.
//
// ⚠ HIGH BLAST RADIUS: this endpoint can change how the Leader/Workers
// authenticate, which TLS versions they accept, and API availability itself.
// A bad deploy could disrupt connectivity to the very endpoint this app talks
// to. The platform's human approval gate (required for production) is the
// primary safeguard; deploy() also snapshots the FULL live settings object
// before patching so rollback can restore an exact prior state regardless of
// PATCH's merge semantics.
//
// NOTE: field shapes follow the documented SystemSettingsConf schema. Verify
// against a live Cribl.

import { CRIBL_ID_RE } from '../../lib/criblCommon'

export const WORKER_GROUP_SETTINGS_RESOURCE = 'system/settings/conf'

export interface ParsedSettings {
  settings: Record<string, unknown> | null
  error: string | null
}

/** Parse the `settings` textarea (JSON) — the partial object to PATCH. */
export function parseSettings(raw: unknown): ParsedSettings {
  const text = String(raw ?? '').trim()
  if (!text) return { settings: null, error: 'settings is empty — provide at least one setting to enforce, as JSON.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { settings: null, error: `settings is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { settings: null, error: 'settings must be a JSON object.' }
  }
  return { settings: parsed as Record<string, unknown>, error: null }
}

/**
 * Deeply project `live` down to only the paths present in `shape` (recursing
 * into plain nested objects) — so a PARTIAL declared settings object is
 * compared against the equivalent slice of the live object, not the live
 * object's many undeclared sibling fields (which would otherwise read as
 * false drift).
 */
export function deepPick(live: unknown, shape: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!live || typeof live !== 'object') return out
  const liveObj = live as Record<string, unknown>
  for (const key of Object.keys(shape)) {
    const shapeValue = shape[key]
    const liveValue = liveObj[key]
    if (shapeValue && typeof shapeValue === 'object' && !Array.isArray(shapeValue)) {
      out[key] = deepPick(liveValue, shapeValue as Record<string, unknown>)
    } else {
      out[key] = liveValue
    }
  }
  return out
}

export { CRIBL_ID_RE }
