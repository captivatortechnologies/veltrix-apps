// Shared helpers for the Vectra Match Ruleset Assignment config type (deploy +
// rollback + drift).
//
// Maps an already-uploaded Vectra Match custom ruleset (identified by its UUID) to
// the sensor devices that should run it. Shapes follow Vectra's official client
// (vectra_api_tools, VectraClientV2_5):
//   list:     GET    /vectra-match/assignment                   → ALL existing (uuid, device) mappings
//   assign:   POST   /vectra-match/assignment  { uuid, device_serials: [...] }  (adds — does not replace)
//   unassign: DELETE /vectra-match/assignment  { uuid, device_serial }          (removes ONE device)
//
// Ruleset CONTENT (the actual Suricata rules file) is NOT managed here — see the
// app README "Coverage" for why (no confirmed way to enumerate existing rulesets by
// identity, so uploads can't be safely upserted). This config type only reconciles
// WHICH sensors run an existing ruleset, which the platform-wide GET (no per-ruleset
// filter) makes fully enumerable and safely reconcilable: for each declared item,
// devices present live but not declared are unassigned (DELETE, one call per device);
// devices declared but not live are assigned (one bulk POST for the whole added set).
//
// FLAG (verify against a live Vectra): the list envelope shape (bare array vs a
// wrapped object) is read defensively.

export interface MatchAssignment {
  uuid?: string
  device_serial?: string
  [key: string]: unknown
}

/** Unwrap the Vectra Match assignment list, tolerant of the envelope shape. */
export function assignmentsFromList(list: unknown): MatchAssignment[] {
  if (Array.isArray(list)) return list as MatchAssignment[]
  if (list && typeof list === 'object') {
    const o = list as { assignments?: unknown; results?: unknown }
    if (Array.isArray(o.assignments)) return o.assignments as MatchAssignment[]
    if (Array.isArray(o.results)) return o.results as MatchAssignment[]
  }
  return []
}

/** Every device serial currently assigned to a given ruleset uuid. */
export function devicesForUuid(assignments: MatchAssignment[], uuid: string): Set<string> {
  const set = new Set<string>()
  for (const a of assignments) {
    if (String(a.uuid ?? '').trim() === uuid && a.device_serial) set.add(String(a.device_serial).trim())
  }
  return set
}

/** Split a comma/whitespace-separated field into a trimmed, de-duplicated list. */
export function parseDeviceList(value: unknown): string[] {
  const seen = new Set<string>()
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !seen.has(s) && (seen.add(s), true))
}
