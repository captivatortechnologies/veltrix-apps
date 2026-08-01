// Shared helpers for the SonarQube Quality Profiles config type (validate + deploy +
// rollback + drift). Pure and network-free so validate.ts and the tests can use it.
//
// A quality profile is authored as a name (identity), a language, an optional parent
// profile name (inheritance) and a default flag, plus an optional list of rule keys to
// activate. Applied over the SonarQube Web API (/api/qualityprofiles). A profile's
// identity is the (name, language) pair — SonarQube allows the same profile name across
// different languages, so both are needed to address one. Verify language / rule keys
// against your SonarQube version.

/** A profile as returned by /api/qualityprofiles/search ({ profiles: [...] }). */
export interface SonarProfile {
  key?: string
  name?: string
  language?: string
  languageName?: string
  isDefault?: boolean
  isInherited?: boolean
  isBuiltIn?: boolean
  parentKey?: string
  parentName?: string
  activeRuleCount?: number
  [key: string]: unknown
}

/** `isDefault` may arrive as a boolean or 'true'/'false' string — normalize. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
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

/** The name of the default profile for a language, if any (used to restore on rollback). */
export function defaultProfileName(profiles: SonarProfile[], language: string): string | null {
  const l = language.trim().toLowerCase()
  const def = profiles.find((p) => String(p.language ?? '').trim().toLowerCase() === l && p.isDefault === true)
  return def?.name ? String(def.name) : null
}

export interface RuleKeyParse {
  keys: string[]
  malformed: string[]
}

/**
 * Parse the "rule keys to activate" textarea. One rule key per non-blank, non-`#` line,
 * shaped `<repository>:<rule>` (e.g. `java:S1067`). Malformed lines are reported (never
 * silently dropped) so validate can warn. Duplicates are collapsed (order preserved).
 */
export function parseRuleKeys(text: unknown): RuleKeyParse {
  const keys: string[] = []
  const malformed: string[] = []
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((line) => {
      const t = line.trim()
      if (!t || t.startsWith('#')) return
      if (!/^\S+:\S+$/.test(t)) {
        malformed.push(t)
        return
      }
      if (!keys.includes(t)) keys.push(t)
    })
  return { keys, malformed }
}

/** Collect rule keys from a /api/rules/search response ({ rules: [{ key }] }). */
export function ruleKeysFromSearch(payload: unknown): string[] {
  const rules =
    payload && typeof payload === 'object' && Array.isArray((payload as { rules?: unknown }).rules)
      ? (payload as { rules: Array<{ key?: unknown }> }).rules
      : []
  return rules.map((r) => String(r.key ?? '')).filter(Boolean)
}
