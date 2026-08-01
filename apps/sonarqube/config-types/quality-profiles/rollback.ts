import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import { profilesFromSearch, findProfile, type SonarProfile } from './_shared'

/**
 * Undo a quality-profiles deploy from rollbackData (written by deploy()):
 *   - a profile we CREATED (existed=false) is deleted (POST /api/qualityprofiles/delete),
 *     which also removes its rule activations and inheritance.
 *   - a profile that already EXISTED has its parent restored (change_parent to the prior
 *     parent, or change_parent with no parentQualityProfile to detach) and the rule keys
 *     we newly activated are deactivated (POST /api/qualityprofiles/deactivate_rule).
 *   - the prior default profile per language is re-selected (POST /api/qualityprofiles/set_default).
 * Built-in profiles were never edited, so nothing is restored for them. Best-effort — a
 * failure on one profile does not abort the rest.
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

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    priorDefaultByLanguage?: Record<string, string | null>
    profiles?: ProfileEntry[]
  }
  const profiles = data.profiles ?? []
  if (profiles.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for quality profile rollback' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const searchCache = new Map<string, SonarProfile[]>()
  async function keyOf(name: string, language: string): Promise<string> {
    const cacheKey = language.toLowerCase()
    if (!searchCache.has(cacheKey)) {
      try {
        searchCache.set(cacheKey, profilesFromSearch(await getJson<unknown>(`${base}/api/qualityprofiles/search?language=${enc(language)}`, headers)))
      } catch {
        searchCache.set(cacheKey, [])
      }
    }
    const match = findProfile(searchCache.get(cacheKey)!, name, language)
    return match?.key ? String(match.key) : ''
  }

  let removed = 0
  let restored = 0
  let skipped = 0
  const failures: string[] = []

  for (const profile of profiles) {
    try {
      if (!profile.existed) {
        await postForm(`${base}/api/qualityprofiles/delete`, headers, { language: profile.language, qualityProfile: profile.name })
        removed++
        continue
      }
      if (profile.isBuiltIn) {
        skipped++
        continue
      }
      // Restore parent (empty parentQualityProfile detaches — form-encoder drops the blank).
      await postForm(`${base}/api/qualityprofiles/change_parent`, headers, {
        language: profile.language,
        qualityProfile: profile.name,
        parentQualityProfile: profile.priorParentName ?? undefined,
      })
      // Deactivate the rules we newly activated.
      if (profile.activatedRuleKeys?.length) {
        const profileKey = await keyOf(profile.name, profile.language)
        if (profileKey) {
          for (const rule of profile.activatedRuleKeys) {
            await postForm(`${base}/api/qualityprofiles/deactivate_rule`, headers, { key: profileKey, rule })
          }
        }
      }
      restored++
    } catch (error) {
      failures.push(`${profile.name} (${profile.language}): ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  // Restore the default profile that was set per language before the deploy (best-effort).
  for (const [language, name] of Object.entries(data.priorDefaultByLanguage ?? {})) {
    if (!name) continue
    try {
      await postForm(`${base}/api/qualityprofiles/set_default`, headers, { language, qualityProfile: name })
    } catch (error) {
      failures.push(`default(${language}=${name}): ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rollback partially failed: ${removed} removed, ${restored} restored, ${skipped} skipped. Errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back quality profiles: ${removed} removed, ${restored} restored${skipped ? `, ${skipped} skipped (built-in)` : ''}.` }
}
