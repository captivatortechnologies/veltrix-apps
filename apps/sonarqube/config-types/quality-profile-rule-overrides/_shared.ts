// Shared helpers for the SonarQube Quality Profile Rule Overrides config type
// (validate + deploy + rollback + drift). Pure and network-free so validate.ts and
// the tests can use it.
//
// This type manages a PER-RULE override — an explicit severity, parameter values
// and/or "prioritized rule" flag — for one specific (profile, rule) pair, via the
// SINGULAR SonarQube Web API actions `api/qualityprofiles/activate_rule` and
// `deactivate_rule`. It is a sibling/companion to the Quality Profiles config type,
// which can only bulk-activate a flat list of rule keys (via `activate_rules`) at
// each rule's DEFAULT severity — the bulk endpoint cannot express a per-rule
// override, which is exactly the gap this type fills.
//
// KNOWN INTERACTION (not a bug): this type and Quality Profiles' `activateRuleKeys`
// can both touch the same rule in the same profile. Whichever config type deploys
// LAST wins for that rule's severity. This type also never deactivates or resets a
// rule that is removed from ITS OWN canvas — it only ever pushes what it currently
// declares, exactly like Permission Templates' "only declared groups are managed"
// philosophy — because being destructive here could silently strip an activation
// this type never owned (e.g. one from Quality Profiles' bulk list, or a built-in
// default).
//
// A profile's identity is the (name, language) pair; its opaque `key` (needed by
// activate_rule/deactivate_rule) is resolved via /api/qualityprofiles/search?language=..,
// the same idiom the Quality Profiles config type uses. We deliberately do NOT expose
// the newer `impacts` param (an MQR-mode-specific override format that overlaps with
// `severity`) — an intentional, honest exclusion to keep this type's scope to the
// classic severity/params/prioritizedRule/reset surface.
//
// Verified live against a running SonarQube instance's own `api/webservices`
// reflection endpoints and a live `api/rules/search` probe.

/** Severity keys the SonarQube Web API accepts for `activate_rule`'s `severity` param. */
export const SEVERITIES = new Set(['INFO', 'MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'])

/**
 * A profile as returned by /api/qualityprofiles/search ({ profiles: [...] }). A
 * minimal local copy of the shape in quality-profiles/_shared.ts — config types in
 * this app are self-contained and do not import across each other's directories.
 */
export interface SonarProfile {
  key?: string
  name?: string
  language?: string
}

/** Unwrap SonarQube's `{ profiles: [...] }` search envelope into a flat array. */
export function profilesFromSearch(payload: unknown): SonarProfile[] {
  if (payload && typeof payload === 'object' && Array.isArray((payload as { profiles?: unknown }).profiles)) {
    return (payload as { profiles: SonarProfile[] }).profiles
  }
  return []
}

/** Find a live profile by (name, language). Names are case-sensitive; language is not. */
export function findProfile(profiles: SonarProfile[], name: string, language: string): SonarProfile | null {
  const n = name.trim()
  const l = language.trim().toLowerCase()
  return (
    profiles.find(
      (p) => String(p.name ?? '').trim() === n && String(p.language ?? '').trim().toLowerCase() === l,
    ) ?? null
  )
}

/** `reset` / `prioritizedRule` may arrive as a boolean or 'true'/'false' string — normalize. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

export interface ParsedParam {
  key: string
  value: string
}
export interface ParamParseError {
  raw: string
  code: 'INVALID_PARAM'
  message: string
}
export interface ParamParseResult {
  params: ParsedParam[]
  errors: ParamParseError[]
}

/**
 * Parse the rule-parameters textarea. One `key=value` pair per non-blank, non-`#`
 * line. A line with no `=`, or an empty key, is reported as an error (never
 * silently dropped) so validate can surface it — matching quality-gates'
 * `parseConditions` philosophy of never swallowing a malformed line.
 */
export function parseParams(text: unknown): ParamParseResult {
  const params: ParsedParam[] = []
  const errors: ParamParseError[] = []

  String(text ?? '')
    .split(/\r?\n/)
    .forEach((line) => {
      const t = line.trim()
      if (!t || t.startsWith('#')) return

      const idx = t.indexOf('=')
      if (idx < 0) {
        errors.push({ raw: t, code: 'INVALID_PARAM', message: `Parameter "${t}" must be "key=value".` })
        return
      }
      const key = t.slice(0, idx).trim()
      const value = t.slice(idx + 1).trim()
      if (!key) {
        errors.push({ raw: t, code: 'INVALID_PARAM', message: `Parameter "${t}" is missing a key.` })
        return
      }
      params.push({ key, value })
    })

  return { params, errors }
}

/** Render parsed params back to the semicolon-separated form `activate_rule`'s `params` field expects. */
export function formatParams(params: ParsedParam[]): string {
  return params.map((p) => `${p.key}=${p.value}`).join(';')
}

/**
 * One entry of the `actives` map in a /api/rules/search response — the live
 * activation record for a rule in the queried profile (see the verified shape in
 * this type's README / spec). `inherit` is 'NONE' | 'INHERITED' | 'OVERRIDES'.
 */
export interface ActiveRuleRecord {
  qProfile?: string
  inherit?: string
  severity?: string
  params?: Array<{ key?: string; value?: string }>
  prioritizedRule?: boolean
}

/**
 * Read a rule's current activation record for the queried profile out of a
 * /api/rules/search?...&f=actives response: `payload.actives[ruleKey][0]`. Fully
 * defensive — `payload` may not be an object, `actives` may be missing or not an
 * object, and the per-rule array may be missing or empty; every case returns null
 * rather than throwing, which is treated as "not currently active in this profile".
 */
export function activeRecordFor(payload: unknown, ruleKey: string): ActiveRuleRecord | null {
  if (!payload || typeof payload !== 'object') return null
  const actives = (payload as { actives?: unknown }).actives
  if (!actives || typeof actives !== 'object') return null
  const list = (actives as Record<string, unknown>)[ruleKey]
  if (!Array.isArray(list) || list.length === 0) return null
  const first = list[0]
  return first && typeof first === 'object' ? (first as ActiveRuleRecord) : null
}
