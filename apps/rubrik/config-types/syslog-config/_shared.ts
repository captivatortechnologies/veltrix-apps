// Shared helpers for the Rubrik Syslog Configuration config type (deploy +
// rollback + drift).
//
// Rubrik CDM forwards cluster events/audit logs to a syslog server. The cluster
// supports a SINGLE active syslog target — creating a new one replaces whatever
// was configured before (there is no PATCH; the mechanism is delete-then-create).
// Managed over the Rubrik CDM internal REST API:
//   list:   GET    /api/internal/syslog                 -> { hasMore, total, data:[{id,hostname,protocol,port}] }
//   create: POST   /api/internal/syslog   { hostname, protocol, port }
//   delete: DELETE /api/internal/syslog/{id}
//
// Verified against the Rubrik Python SDK's cluster.configure_syslog()
// (rubrikinc/rubrik-sdk-for-powershell's PowerShell equivalent only exposes a
// Get-RubrikSyslogServer read; rubrik-sdk-for-python's cluster.py is the source
// for the write path): it reads the current config, and when one already exists
// deletes it (historically a fixed id of "1" — this app instead deletes using
// the REAL id returned by the GET, falling back to "1" only if the id is
// missing) before POSTing the new one — no field carries a secret.

/** Transport protocols Rubrik accepts for the syslog connection. */
export const SYSLOG_PROTOCOLS = ['UDP', 'TCP'] as const
export type SyslogProtocol = (typeof SYSLOG_PROTOCOLS)[number]

/** The historical fixed id CDM used for the (only ever one) syslog config. */
export const LEGACY_SYSLOG_ID = '1'

/** One syslog export target as returned by the Rubrik CDM internal API. */
export interface RubrikSyslogConfig {
  id?: string
  hostname?: string
  protocol?: string
  port?: number
  [key: string]: unknown
}

/** Trim + normalize a value. */
export function normalizeHostname(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a canvas protocol field to a known enum value (defaults to UDP). */
export function normalizeProtocol(value: unknown): SyslogProtocol {
  const s = String(value ?? '').trim().toUpperCase()
  return (SYSLOG_PROTOCOLS as readonly string[]).includes(s) ? (s as SyslogProtocol) : 'UDP'
}

/** Coerce a canvas port field to a valid TCP/UDP port (defaults to 514). */
export function normalizePort(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 514
}

/** Build the create-request body from the flat canvas fields. */
export function buildSyslogBody(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    hostname: normalizeHostname(fields.hostname),
    protocol: normalizeProtocol(fields.protocol),
    port: normalizePort(fields.port),
  }
}

/** Unwrap the internal list envelope ({ data, total, hasMore }) into a flat array. */
export function syslogConfigsFromList(resp: unknown): RubrikSyslogConfig[] {
  if (Array.isArray(resp)) return resp as RubrikSyslogConfig[]
  if (resp && typeof resp === 'object' && Array.isArray((resp as { data?: unknown }).data)) {
    return (resp as { data: RubrikSyslogConfig[] }).data
  }
  return []
}

/** The cluster's single active syslog config (if any) — CDM only ever keeps one. */
export function currentSyslogConfig(resp: unknown): RubrikSyslogConfig | null {
  const list = syslogConfigsFromList(resp)
  return list[0] ?? null
}

/** Flatten a syslog config into a comparable string map for drift detection. */
export function summarizeSyslog(cfg: RubrikSyslogConfig | null | undefined): Record<string, string> {
  if (!cfg) return {}
  return {
    hostname: normalizeHostname(cfg.hostname),
    protocol: normalizeProtocol(cfg.protocol),
    port: String(normalizePort(cfg.port)),
  }
}

/** True when two syslog configs (declared vs live) describe the same target. */
export function syslogConfigsEqual(a: RubrikSyslogConfig | null, b: RubrikSyslogConfig | null): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  const sa = summarizeSyslog(a)
  const sb = summarizeSyslog(b)
  return sa.hostname === sb.hostname && sa.protocol === sb.protocol && sa.port === sb.port
}
