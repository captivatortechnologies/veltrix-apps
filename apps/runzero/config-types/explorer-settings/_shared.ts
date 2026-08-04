// Shared helpers for the runZero Explorer Settings config type (deploy + rollback + drift + validate).
//
// A runZero Explorer (formerly "Agent") is the deployed service that performs scans; it is
// installed out-of-band (downloaded + run on a host) and cannot be created or removed through this
// API. Its per-explorer SETTINGS — which Site it's assigned to, and its scan concurrency — CAN be
// tuned through the API, which is what this config type manages (verified against
// runZeroInc/runzero-api runzero-api.yml — Agent / AgentPatchedSettings):
//   List:    GET   /org/explorers                    → array of Agent
//   Get:     GET   /org/explorers/{id}
//   Update:  PATCH /org/explorers/{id}                body AgentPatchedSettings → Agent
//   (no create, no delete — explorers are installed/uninstalled outside the API)
//
// This config type therefore has NO create path: every item must reference an explorer that
// already exists (by name or UUID); a reference that doesn't resolve surfaces as a clear 404 from
// the PATCH call rather than a pre-flight check (the same "let the API be the authority" choice
// scan-tasks makes for its Site reference).
//
// FLAG (write-only field — cannot round-trip): AgentPatchedSettings accepts `settings.
// max_concurrent_scans`, but the Agent response schema NEVER reflects a `settings` object back —
// there is nothing live to read it from. As a direct consequence (the same shape as Cisco Meraki's
// `syslog_default_rule` in this repo):
//   - driftDetect NEVER compares max_concurrent_scans — there is nothing to diff against.
//   - rollback NEVER restores max_concurrent_scans — there is no prior value on record; the
//     restore PATCH omits the `settings` key entirely rather than guessing.
//   - every successful deploy re-applies whatever value is currently declared on the canvas.
// `site_id` IS reflected back on Agent, so it fully round-trips (read/write/diff/restore).
//
// SCOPE: this config type is ORG-scoped (/org/explorers), unlike the account-scoped types in this
// app — it uses the same Organization API key as Sites/Scan Tasks.

/** One runZero Agent/Explorer as returned by GET /org/explorers (subset of the fields we use). */
export interface RunzeroExplorer {
  id?: string
  name?: string
  site_id?: string
  connected?: boolean
  inactive?: boolean
  [key: string]: unknown
}

/** A runZero Site as far as explorer settings need it — resolve a site name to its id. */
export interface RunzeroSiteLite {
  id?: string
  name?: string
  [key: string]: unknown
}

/** The AgentPatchedSettings request body for PATCH /org/explorers/{id}. */
export interface RunzeroAgentPatchedSettings {
  site_id?: string
  settings?: { max_concurrent_scans?: number }
}

/** One entry in deploy's rollbackData.previous — what deploy did to a single explorer. */
export interface ExplorerSettingsRollbackEntry {
  explorerRef: string
  explorerId: string | null
  priorSiteId: string | null
}

/** Trim any value to a string. */
export function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a canvas number field to a positive integer, or undefined when blank/invalid. */
export function positiveIntOrUndefined(value: unknown): number | undefined {
  if (value === '' || value === null || value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined
}

/** Resolve an explorer reference (name or UUID) to its id using the live explorer list; falls back to the raw ref. */
export function resolveExplorerId(explorers: RunzeroExplorer[], ref: unknown): string {
  const r = text(ref)
  if (!r) return r
  const byName = explorers.find((e) => text(e.name).toLowerCase() === r.toLowerCase())
  return byName?.id ?? r
}

/** Find a live explorer by its resolved id. */
export function findExplorerById(explorers: RunzeroExplorer[], id: string): RunzeroExplorer | null {
  if (!id) return null
  return explorers.find((e) => e.id === id) ?? null
}

/** Resolve a site reference (name or UUID) to a site id using the live site list; falls back to the raw ref. */
export function resolveSiteId(sites: RunzeroSiteLite[], siteRef: unknown): string {
  const ref = text(siteRef)
  if (!ref) return ref
  const byName = sites.find((s) => text(s.name).toLowerCase() === ref.toLowerCase())
  return byName?.id ?? ref
}

/** Build the AgentPatchedSettings body from canvas fields. Keys are omitted entirely when not declared. */
export function buildPatchedSettings(fields: Record<string, unknown>, sites: RunzeroSiteLite[]): RunzeroAgentPatchedSettings {
  const body: RunzeroAgentPatchedSettings = {}
  const siteRef = text(fields.site)
  if (siteRef) body.site_id = resolveSiteId(sites, siteRef)
  const maxConcurrentScans = positiveIntOrUndefined(fields.maxConcurrentScans)
  if (maxConcurrentScans !== undefined) body.settings = { max_concurrent_scans: maxConcurrentScans }
  return body
}

/** Whether a canvas item declares anything to apply (an item with neither field set is a no-op). */
export function declaresChange(fields: Record<string, unknown>): boolean {
  return text(fields.site).length > 0 || positiveIntOrUndefined(fields.maxConcurrentScans) !== undefined
}
