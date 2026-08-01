import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson } from '../../lib/sonarqubeApi'
import {
  profilesFromSearch,
  findProfile,
  parseRuleKeys,
  ruleKeysFromSearch,
  normalizeBool,
  type SonarProfile,
} from './_shared'

/**
 * Drift for quality profiles: compare presence, parent (when declared), default flag and
 * declared rule activation against the live profile in SonarQube. Best-effort — a profile
 * or reading that can't be resolved is skipped rather than raising false drift. Read-only:
 *   GET /api/qualityprofiles/search?language=..      → live profiles (parent + default)
 *   GET /api/rules/search?qprofile=..&activation=true → the profile's active rule keys
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
    const name = String(item.fields.name ?? '').trim()
    const language = String(item.fields.language ?? '').trim()
    if (!name || !language) continue

    const live = await search(language)
    if (!live) continue
    const match = findProfile(live, name, language)
    if (!match) {
      diffs.push({ field: `${name} (${language})`, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    if (normalizeBool(item.fields.isDefault) && match.isDefault !== true) {
      diffs.push({ field: `${name} (${language}).isDefault`, expected: true, actual: Boolean(match.isDefault), severity: 'warning' })
    }

    const parentName = String(item.fields.parentName ?? '').trim()
    if (parentName && String(match.parentName ?? '') !== parentName) {
      diffs.push({ field: `${name} (${language}).parent`, expected: parentName, actual: String(match.parentName ?? '(none)'), severity: 'warning' })
    }

    const { keys: ruleKeys } = parseRuleKeys(item.fields.activateRuleKeys)
    if (ruleKeys.length > 0 && match.key) {
      let active: Set<string>
      try {
        active = new Set(ruleKeysFromSearch(await getJson<unknown>(`${base}/api/rules/search?qprofile=${enc(String(match.key))}&activation=true&ps=500`, headers)))
      } catch {
        continue // can't read active rules — skip rather than assert drift
      }
      for (const ruleKey of ruleKeys) {
        if (!active.has(ruleKey)) {
          diffs.push({ field: `${name} (${language}).rule:${ruleKey}`, expected: 'active', actual: 'inactive', severity: 'warning' })
        }
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
