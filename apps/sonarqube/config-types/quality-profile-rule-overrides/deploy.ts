import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import {
  profilesFromSearch,
  findProfile,
  parseParams,
  formatParams,
  activeRecordFor,
  normalizeBool,
  type SonarProfile,
  type ActiveRuleRecord,
} from './_shared'

/**
 * Deploy per-rule quality-profile overrides over the SonarQube Web API:
 *   resolve profile:  GET  /api/qualityprofiles/search?language=..                   → the profile's opaque key
 *   read prior state: GET  /api/rules/search?qprofile=..&rule_key=..&activation=true&f=actives → existing activation (rollback)
 *   apply:            POST /api/qualityprofiles/activate_rule   { key, rule, severity?, params?, prioritizedRule?, reset? }
 *
 * A profile is upserted by nothing — it must already exist; this type only overrides
 * rule activation within it, never creates the profile itself (that is Quality
 * Profiles' job). Every item is applied INDEPENDENTLY and best-effort: an item whose
 * profile can't be resolved, or whose activate_rule call fails, is recorded as a
 * failure and the rest of the (up to 500-item) canvas still proceeds — one bad
 * reference does not abort the whole deploy. Overall `success` is true only when
 * every item applied cleanly; the message always reports both counts honestly.
 *
 * rollbackData records, per successfully-applied item, whether the rule was already
 * active in the profile (`existed`) and — when it was — its PRIOR severity, params
 * and prioritizedRule flag, so rollback can restore the exact prior override (or
 * deactivate the rule if this deploy is what activated it).
 */
interface RuleOverrideEntry {
  profileName: string
  language: string
  ruleKey: string
  profileKey: string
  existed: boolean
  priorSeverity?: string
  priorParams?: Array<{ key?: string; value?: string }>
  priorPrioritized?: boolean
}

const enc = encodeURIComponent
const label = (profileName: string, language: string, ruleKey: string) => `${ruleKey} in ${profileName} (${language})`

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for quality profile rule override deployment' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const searchCache = new Map<string, SonarProfile[]>()
  async function search(language: string): Promise<SonarProfile[]> {
    const key = language.toLowerCase()
    if (searchCache.has(key)) return searchCache.get(key)!
    let profiles: SonarProfile[] = []
    try {
      profiles = profilesFromSearch(await getJson<unknown>(`${base}/api/qualityprofiles/search?language=${enc(language)}`, headers))
    } catch {
      profiles = []
    }
    searchCache.set(key, profiles)
    return profiles
  }

  const overrides: RuleOverrideEntry[] = []
  const applied: string[] = []
  const failures: string[] = []

  for (const item of items) {
    const profileName = String(item.fields.profileName ?? '').trim()
    const language = String(item.fields.language ?? '').trim()
    const ruleKey = String(item.fields.ruleKey ?? '').trim()
    if (!profileName || !language || !ruleKey) continue

    try {
      const profiles = await search(language)
      const profile = findProfile(profiles, profileName, language)
      if (!profile?.key) {
        throw new Error(`Quality profile "${profileName}" (${language}) was not found — cannot resolve its key.`)
      }
      const profileKey = String(profile.key)

      let prior: ActiveRuleRecord | null = null
      try {
        const searchResp = await getJson<unknown>(
          `${base}/api/rules/search?qprofile=${enc(profileKey)}&rule_key=${enc(ruleKey)}&activation=true&f=actives`,
          headers,
        )
        prior = activeRecordFor(searchResp, ruleKey)
      } catch {
        prior = null // treat an unreadable prior state as "no prior record" rather than aborting
      }
      const existed = prior !== null

      const reset = normalizeBool(item.fields.reset)
      if (reset) {
        await postForm(`${base}/api/qualityprofiles/activate_rule`, headers, { key: profileKey, rule: ruleKey, reset: true })
      } else {
        const severity = String(item.fields.severity ?? '').trim()
        const prioritizedRule = normalizeBool(item.fields.prioritizedRule)
        const { params } = parseParams(item.fields.params)
        await postForm(`${base}/api/qualityprofiles/activate_rule`, headers, {
          key: profileKey,
          rule: ruleKey,
          severity: severity || undefined,
          params: formatParams(params) || undefined,
          prioritizedRule: prioritizedRule || undefined,
        })
      }

      overrides.push({
        profileName,
        language,
        ruleKey,
        profileKey,
        existed,
        priorSeverity: prior?.severity,
        priorParams: prior?.params,
        priorPrioritized: prior?.prioritizedRule,
      })
      applied.push(label(profileName, language, ruleKey))
    } catch (error) {
      failures.push(`${label(profileName, language, ruleKey)}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const message =
    failures.length > 0
      ? `Applied ${applied.length} rule override(s); ${failures.length} failed: ${failures.join('; ')}`
      : `Applied ${applied.length} rule override(s): ${applied.join(', ') || '(none)'}`

  return {
    success: failures.length === 0,
    message,
    artifacts: { applied, failures },
    rollbackData: { overrides },
  }
}
