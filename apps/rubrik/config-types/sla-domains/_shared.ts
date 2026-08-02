// Shared helpers for the Rubrik SLA Domains config type (deploy + rollback + drift).
//
// An SLA Domain is Rubrik's backup policy object: a name plus a set of snapshot
// FREQUENCIES, each with a retention. The Rubrik CDM v2 API models frequencies as
// an OBJECT keyed by time unit (hourly / daily / weekly / monthly / ...), each a
// { frequency, retention } record, with weekly/monthly carrying an extra
// dayOfWeek / dayOfMonth field.
//
// NOTE: SLA-domain shapes here follow the Rubrik CDM 8.x v2 REST API
// (/api/v2/sla_domain). The exact retention-unit semantics per tier vary by CDM
// version — verify against a live Rubrik CDM cluster.

/** Allowed weekly anchor days (Rubrik dayOfWeek enum). */
export const DAYS_OF_WEEK = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const

/** Allowed monthly anchor days (Rubrik dayOfMonth enum). */
export const DAYS_OF_MONTH = ['FirstDay', 'Fifteenth', 'LastDay'] as const

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number]
export type DayOfMonth = (typeof DAYS_OF_MONTH)[number]

/** One tier of the v2 frequencies object. */
export interface FrequencyTier {
  frequency: number
  retention: number
  dayOfWeek?: DayOfWeek
  dayOfMonth?: DayOfMonth
}

/** The v2 `frequencies` object: each key present only when configured. */
export interface SlaFrequencies {
  hourly?: FrequencyTier
  daily?: FrequencyTier
  weekly?: FrequencyTier
  monthly?: FrequencyTier
}

/** One SLA Domain as returned by the Rubrik CDM v2 API. */
export interface RubrikSlaDomain {
  id?: string
  name?: string
  description?: string
  frequencies?: SlaFrequencies
  [key: string]: unknown
}

/** The four snapshot tiers this config type manages. */
export const TIERS = ['hourly', 'daily', 'weekly', 'monthly'] as const
export type Tier = (typeof TIERS)[number]

/** Coerce a canvas field to a non-negative integer (0 when blank/invalid). */
export function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Trim + normalize a name for stable identity matching. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * Build the v2 `frequencies` object from the flat canvas fields. A tier is
 * included only when it has a positive frequency AND retention — an all-zero tier
 * is treated as "off".
 */
export function buildFrequencies(fields: Record<string, unknown>): SlaFrequencies {
  const frequencies: SlaFrequencies = {}

  const hourlyFreq = toInt(fields.hourlyFrequency)
  const hourlyRet = toInt(fields.hourlyRetention)
  if (hourlyFreq > 0 && hourlyRet > 0) frequencies.hourly = { frequency: hourlyFreq, retention: hourlyRet }

  const dailyFreq = toInt(fields.dailyFrequency)
  const dailyRet = toInt(fields.dailyRetention)
  if (dailyFreq > 0 && dailyRet > 0) frequencies.daily = { frequency: dailyFreq, retention: dailyRet }

  const weeklyFreq = toInt(fields.weeklyFrequency)
  const weeklyRet = toInt(fields.weeklyRetention)
  if (weeklyFreq > 0 && weeklyRet > 0) {
    frequencies.weekly = {
      frequency: weeklyFreq,
      retention: weeklyRet,
      dayOfWeek: normalizeDayOfWeek(fields.weeklyDayOfWeek),
    }
  }

  const monthlyFreq = toInt(fields.monthlyFrequency)
  const monthlyRet = toInt(fields.monthlyRetention)
  if (monthlyFreq > 0 && monthlyRet > 0) {
    frequencies.monthly = {
      frequency: monthlyFreq,
      retention: monthlyRet,
      dayOfMonth: normalizeDayOfMonth(fields.monthlyDayOfMonth),
    }
  }

  return frequencies
}

function normalizeDayOfWeek(value: unknown): DayOfWeek {
  const s = normalizeName(value)
  return (DAYS_OF_WEEK as readonly string[]).includes(s) ? (s as DayOfWeek) : 'Sunday'
}

function normalizeDayOfMonth(value: unknown): DayOfMonth {
  const s = normalizeName(value)
  return (DAYS_OF_MONTH as readonly string[]).includes(s) ? (s as DayOfMonth) : 'LastDay'
}

/** True when at least one frequency tier is configured. */
export function hasAnyTier(frequencies: SlaFrequencies): boolean {
  return TIERS.some((tier) => frequencies[tier] !== undefined)
}

/**
 * Build the v2 SLA Domain request body from the flat canvas fields. The empty
 * backup-window arrays are required by the create endpoint; retention-locked and
 * archival/replication specs are out of scope for the v0.1.0 foundation.
 */
export function buildSlaBody(fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: normalizeName(fields.name),
    frequencies: buildFrequencies(fields),
    allowedBackupWindows: [],
    firstFullAllowedBackupWindows: [],
  }
  const description = normalizeName(fields.description)
  if (description) body.description = description
  return body
}

/** Unwrap the v2 list envelope ({ data, total, hasMore }) into a flat array. */
export function slaDomainsFromList(resp: unknown): RubrikSlaDomain[] {
  if (Array.isArray(resp)) return resp as RubrikSlaDomain[]
  if (resp && typeof resp === 'object' && Array.isArray((resp as { data?: unknown }).data)) {
    return (resp as { data: RubrikSlaDomain[] }).data
  }
  return []
}

/** Find a live SLA Domain by its (case-sensitive) name; null when absent. */
export function findSlaByName(list: RubrikSlaDomain[], name: string): RubrikSlaDomain | null {
  const n = normalizeName(name)
  if (!n) return null
  return list.find((sla) => normalizeName(sla.name) === n) ?? null
}

/**
 * Flatten a frequencies object into a comparable "tier=frequency/retention"
 * summary for drift detection. Absent tiers are omitted so an off tier on both
 * sides matches.
 */
export function summarizeFrequencies(frequencies: SlaFrequencies | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!frequencies) return out
  for (const tier of TIERS) {
    const t = frequencies[tier]
    if (!t) continue
    const anchor = t.dayOfWeek ?? t.dayOfMonth
    out[tier] = `${t.frequency}/${t.retention}${anchor ? `@${anchor}` : ''}`
  }
  return out
}
