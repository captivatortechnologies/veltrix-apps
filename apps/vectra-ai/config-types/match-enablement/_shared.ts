// Shared helpers for the Vectra Match Enablement config type (deploy + rollback +
// drift).
//
// Vectra Match (Suricata-based Suspect Protocol Activity detections, added in
// Detect v2.5) is enabled/disabled per SENSOR device. Shapes follow Vectra's
// official client (vectra_api_tools, VectraClientV2_5):
//   read:  GET  /vectra-match/enablement?device_serial={serial}
//   write: POST /vectra-match/enablement  body { device_serial, desired_state }
//
// Requires a valid Vectra Match license — an unlicensed brain rejects the write with
// its own error, surfaced as a deploy failure rather than silently faked as
// supported. Vectra Match methods carry a `validate_gte_api_v3_3` gate in the client,
// which (read literally) permits BOTH v2.x (token auth, this app's transport) and
// v3.3+ (OAuth2) clients — confirmed accessible over the same v2.5 token-authed
// transport this app already uses.
//
// FLAG (verify against a live Vectra): the GET response's field name for the current
// state is unconfirmed — the official client returns the raw response without
// parsing it, so this reads defensively across desired_state / state / enabled.

/** Read the live enablement flag from a GET response, tolerant of the field name. */
export function enabledFromGet(body: unknown): boolean | null {
  const o = (body ?? {}) as Record<string, unknown>
  const raw = o.desired_state ?? o.state ?? o.enabled
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'boolean') return raw
  const s = String(raw).trim().toLowerCase()
  if (s === 'true' || s === 'enabled' || s === '1') return true
  if (s === 'false' || s === 'disabled' || s === '0') return false
  return null
}

/** Coerce a canvas value that may be a boolean, 1|0 or 'true'/'false'/'enabled' string. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'on' || s === 'enabled'
}
