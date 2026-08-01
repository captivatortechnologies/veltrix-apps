// Shared helpers for the Cybereason Isolation Rules config type
// (validate + deploy + rollback + drift + tests).
//
// An isolation (exception) rule governs which traffic is blocked or allowed while
// a sensor is isolated. Cybereason assigns a server-side `ruleId`; the authoring
// identity used for upsert is the COMPOSITE (ipAddressString + direction + port),
// since a config author does not know the server id. Deploy reads the live rules,
// matches on that composite, and PUTs by ruleId (carrying the current
// `lastUpdated` optimistic-concurrency token) when it exists, or POSTs otherwise.
//
// CONFIRMED against two public Cybereason clients (forensic-security/cybereason
// rules.py; tobor88 PoshCybereason): GET/POST/PUT /rest/settings/isolation-rule,
// POST /rest/settings/isolation-rule/delete. Body: ipAddressString, port (int; 0 =
// any), blocking (bool), direction (ALL|INCOMING|OUTGOING), ruleId, lastUpdated.
// VERIFY the response shape + the lastUpdated concurrency semantics against a live tenant.

export const ISOLATION_ENDPOINTS = {
  /** CONFIRMED — list all isolation rules. */
  list: '/rest/settings/isolation-rule',
  /** CONFIRMED — create a rule (ruleId null). */
  create: '/rest/settings/isolation-rule',
  /** CONFIRMED — update a rule (full object incl. ruleId + current lastUpdated). */
  update: '/rest/settings/isolation-rule',
  /** CONFIRMED — delete a rule (POST the full rule object to /delete, not HTTP DELETE). */
  remove: '/rest/settings/isolation-rule/delete',
} as const

/** Traffic direction the rule matches. */
export const DIRECTIONS = new Set(['ALL', 'INCOMING', 'OUTGOING'])

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/** A Cybereason isolation rule as authored / read back. */
export interface IsolationRule {
  ruleId?: string | null
  ipAddressString?: string
  port?: number | string
  blocking?: boolean
  direction?: string
  lastUpdated?: number
  [key: string]: unknown
}

/** Is `value` a syntactically valid IPv4 address? */
export function isValidIpv4(value: unknown): boolean {
  return IPV4_RE.test(String(value ?? '').trim())
}

/** Coerce a canvas boolean (true | 'true' | 'on' | 1) into a real boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'on'
}

/**
 * Normalize a port for the request + identity: blank → '' (no port restriction),
 * a non-negative integer otherwise (0 = any port). Non-numeric junk collapses to ''.
 */
export function normalizePort(value: unknown): number | '' {
  if (value === '' || value === null || value === undefined) return ''
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : ''
}

/** Normalize a direction to its upper-case canonical form. */
export function normalizeDirection(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

/** The composite authoring identity of a rule: ipAddressString | direction | port. */
export function ruleIdentity(fields: { ipAddressString?: unknown; direction?: unknown; port?: unknown }): string {
  const ip = String(fields.ipAddressString ?? '').trim().toLowerCase()
  const direction = normalizeDirection(fields.direction) || 'ALL'
  const port = normalizePort(fields.port)
  return `${ip}|${direction}|${port}`
}

/**
 * Build the isolation-rule request body. On create `ruleId` is null; on update the
 * caller supplies the live rule so `ruleId` + `lastUpdated` (the concurrency token)
 * ride along — Cybereason rejects a PUT that omits the current lastUpdated.
 */
export function buildIsolationBody(fields: Record<string, unknown>, existing?: IsolationRule | null): IsolationRule {
  const body: IsolationRule = {
    ruleId: existing?.ruleId ?? null,
    ipAddressString: String(fields.ipAddressString ?? '').trim(),
    port: normalizePort(fields.port),
    blocking: normalizeBool(fields.blocking),
    direction: normalizeDirection(fields.direction) || 'ALL',
  }
  if (existing && existing.lastUpdated !== undefined) body.lastUpdated = existing.lastUpdated
  return body
}

/** Parse the /rest/settings/isolation-rule response into rule rows (array or wrapped). */
export function rulesFromResponse(body: string): IsolationRule[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (Array.isArray(parsed)) return parsed as IsolationRule[]
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const inner = obj.rules ?? obj.isolationRules ?? obj.data ?? obj.items
    if (Array.isArray(inner)) return inner as IsolationRule[]
  }
  return []
}

/** The composite identity of a LIVE rule row (mirrors ruleIdentity for canvas fields). */
export function liveRuleIdentity(rule: IsolationRule): string {
  return ruleIdentity({ ipAddressString: rule.ipAddressString, direction: rule.direction, port: rule.port })
}

/** Index live rules by their composite identity for O(1) upsert / drift lookup. */
export function indexByIdentity(rules: IsolationRule[]): Map<string, IsolationRule> {
  const map = new Map<string, IsolationRule>()
  for (const rule of rules) map.set(liveRuleIdentity(rule), rule)
  return map
}

/** The created rule's ruleId from a POST response (the echoed rule, or { ruleId }). */
export function createdRuleId(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    return String(parsed?.ruleId ?? '').trim()
  } catch {
    return ''
  }
}
