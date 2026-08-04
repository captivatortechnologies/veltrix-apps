import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson } from '../../lib/sonarqubeApi'
import { profilesFromSearch, findProfile, parseParams, activeRecordFor, normalizeBool, type SonarProfile } from './_shared'

/**
 * Drift for rule overrides: compare the declared severity / params / prioritizedRule
 * (when `reset` is false — a reset item intentionally applies none of these, so none
 * are drift-compared) against the rule's live activation record in the profile.
 * Best-effort throughout — a profile or read that can't be resolved is skipped
 * rather than raising false drift. Read-only:
 *   GET /api/qualityprofiles/search?language=..                              → the profile's opaque key
 *   GET /api/rules/search?qprofile=..&rule_key=..&activation=true&f=actives  → the live activation record
 * Verify against your SonarQube version.
 */
const enc = encodeURIComponent

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const searchCache = new Map<string, SonarProfile[]>()
  async function search(language: string): Promise<SonarProfile[] | null> {
    const key = language.toLowerCase()
    if (searchCache.has(key)) return searchCache.get(key)!
    try {
      const profiles = profilesFromSearch(await getJson<unknown>(`${base}/api/qualityprofiles/search?language=${enc(language)}`, headers))
      searchCache.set(key, profiles)
      return profiles
    } catch {
      return null // best-effort: can't read this language, no drift asserted
    }
  }

  for (const item of items) {
    const profileName = String(item.fields.profileName ?? '').trim()
    const language = String(item.fields.language ?? '').trim()
    const ruleKey = String(item.fields.ruleKey ?? '').trim()
    if (!profileName || !language || !ruleKey) continue

    const field = `${profileName} (${language}).${ruleKey}`

    const profiles = await search(language)
    if (!profiles) continue
    const profile = findProfile(profiles, profileName, language)
    if (!profile?.key) {
      diffs.push({ field, expected: 'present', actual: 'profile missing', severity: 'warning' })
      continue
    }

    let live: unknown
    try {
      live = await getJson<unknown>(
        `${base}/api/rules/search?qprofile=${enc(String(profile.key))}&rule_key=${enc(ruleKey)}&activation=true&f=actives`,
        headers,
      )
    } catch {
      continue // can't read this rule's activation — skip rather than assert drift
    }

    const record = activeRecordFor(live, ruleKey)
    if (!record) {
      diffs.push({ field, expected: 'active', actual: 'inactive', severity: 'warning' })
      continue
    }

    if (normalizeBool(item.fields.reset)) continue // a reset item declares no override to compare

    const severity = String(item.fields.severity ?? '').trim()
    if (severity && String(record.severity ?? '') !== severity) {
      diffs.push({ field: `${field}.severity`, expected: severity, actual: String(record.severity ?? '(none)'), severity: 'warning' })
    }

    const { params: desiredParams } = parseParams(item.fields.params)
    const liveParams = new Map((record.params ?? []).map((p) => [String(p.key ?? ''), String(p.value ?? '')]))
    for (const p of desiredParams) {
      const liveValue = liveParams.get(p.key)
      if (liveValue === undefined) {
        diffs.push({ field: `${field}.param.${p.key}`, expected: p.value, actual: '(absent)', severity: 'warning' })
      } else if (liveValue !== p.value) {
        diffs.push({ field: `${field}.param.${p.key}`, expected: p.value, actual: liveValue, severity: 'warning' })
      }
    }

    const prioritizedRule = normalizeBool(item.fields.prioritizedRule)
    if (prioritizedRule !== Boolean(record.prioritizedRule)) {
      diffs.push({ field: `${field}.prioritizedRule`, expected: prioritizedRule, actual: Boolean(record.prioritizedRule), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
