import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import {
  profilesFromSearch,
  findProfile,
  defaultProfileName,
  parseRuleKeys,
  ruleKeysFromSearch,
  normalizeBool,
  type SonarProfile,
} from './_shared'

/**
 * Deploy SonarQube quality profiles over the Web API (/api/qualityprofiles):
 *   search (context):  GET  /api/qualityprofiles/search?language=..     → find the profile + default
 *   create:            POST /api/qualityprofiles/create                 { language, name }
 *   parent:            POST /api/qualityprofiles/change_parent          { language, qualityProfile, parentQualityProfile }
 *   activate rules:    POST /api/qualityprofiles/activate_rules         { targetKey, rule_key }
 *   default:           POST /api/qualityprofiles/set_default            { language, qualityProfile }
 *
 * The (name, language) pair is the stable identity used to upsert — ids/keys vary
 * across SonarQube versions, so every write addresses the profile by name+language
 * (activate_rules is the exception: it needs the profile KEY, resolved from search).
 * A built-in profile ("Sonar way") cannot be edited, so its parent / rule sync is
 * skipped (it can still be set as default). rollbackData records, per profile, whether
 * it existed, its prior parent, the rule keys we newly activated, and the prior default
 * per language — so rollback can restore the prior state or remove a profile we created.
 */
interface ProfileEntry {
  name: string
  language: string
  existed: boolean
  isBuiltIn: boolean
  priorParentName: string | null
  activatedRuleKeys: string[]
}

const enc = encodeURIComponent

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for quality profile deployment' }
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
  async function activeRuleKeys(profileKey: string): Promise<Set<string>> {
    try {
      return new Set(ruleKeysFromSearch(await getJson<unknown>(`${base}/api/rules/search?qprofile=${enc(profileKey)}&activation=true&ps=500`, headers)))
    } catch {
      return new Set()
    }
  }

  const profiles: ProfileEntry[] = []
  const priorDefaultByLanguage: Record<string, string | null> = {}
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      const language = String(item.fields.language ?? '').trim()
      if (!name || !language) continue

      const parentName = String(item.fields.parentName ?? '').trim()
      const wantDefault = normalizeBool(item.fields.isDefault)
      const { keys: ruleKeys } = parseRuleKeys(item.fields.activateRuleKeys)

      let live = await search(language)
      let existing = findProfile(live, name, language)
      const existed = existing != null

      if (!existed) {
        await postForm(`${base}/api/qualityprofiles/create`, headers, { language, name })
        searchCache.delete(language.toLowerCase())
        live = await search(language)
        existing = findProfile(live, name, language)
      }

      const profileKey = existing?.key ? String(existing.key) : ''
      const isBuiltIn = existing?.isBuiltIn === true
      const priorParentName = existing?.parentName ? String(existing.parentName) : null
      let activatedRuleKeys: string[] = []

      if (isBuiltIn) {
        if (wantDefault) {
          if (!(language.toLowerCase() in priorDefaultByLanguage)) priorDefaultByLanguage[language.toLowerCase()] = defaultProfileName(live, language)
          await postForm(`${base}/api/qualityprofiles/set_default`, headers, { language, qualityProfile: name })
        }
        profiles.push({ name, language, existed, isBuiltIn, priorParentName, activatedRuleKeys })
        applied.push(`${name} (${language}, built-in: default only)`)
        continue
      }

      if (parentName && parentName !== priorParentName) {
        await postForm(`${base}/api/qualityprofiles/change_parent`, headers, { language, qualityProfile: name, parentQualityProfile: parentName })
      }

      if (ruleKeys.length > 0 && profileKey) {
        const already = await activeRuleKeys(profileKey)
        activatedRuleKeys = ruleKeys.filter((k) => !already.has(k))
        if (activatedRuleKeys.length > 0) {
          await postForm(`${base}/api/qualityprofiles/activate_rules`, headers, { targetKey: profileKey, rule_key: activatedRuleKeys.join(',') })
        }
      }

      if (wantDefault) {
        if (!(language.toLowerCase() in priorDefaultByLanguage)) priorDefaultByLanguage[language.toLowerCase()] = defaultProfileName(live, language)
        await postForm(`${base}/api/qualityprofiles/set_default`, headers, { language, qualityProfile: name })
      }

      profiles.push({ name, language, existed, isBuiltIn, priorParentName, activatedRuleKeys })
      applied.push(`${name} (${language})`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} quality profile(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { priorDefaultByLanguage, profiles },
    }
  } catch (error) {
    return {
      success: false,
      message: `Quality profile deploy failed after ${applied.length} profile(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { priorDefaultByLanguage, profiles },
    }
  }
}
