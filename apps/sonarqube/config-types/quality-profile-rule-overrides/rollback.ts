import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, postForm } from '../../lib/sonarqubeApi'

/**
 * Undo a quality-profile-rule-overrides deploy from rollbackData (written by
 * deploy()), per recorded entry:
 *   - a rule that was NOT active before this deploy (existed=false) is fully
 *     deactivated: POST /api/qualityprofiles/deactivate_rule { key, rule }.
 *   - a rule that WAS already active (existed=true) has its exact prior severity,
 *     params and prioritizedRule flag restored: POST /api/qualityprofiles/activate_rule
 *     { key, rule, severity?, params?, prioritizedRule? }.
 * An entry whose profile key was never resolved at deploy time (a deploy-time
 * failure on that item) is defensively skipped here too — there is nothing to undo —
 * and counted separately in the result message. Best-effort throughout: a failure on
 * one entry does not abort the rest.
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

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { overrides?: RuleOverrideEntry[] }
  const overrides = data.overrides ?? []
  if (overrides.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for quality profile rule override rollback' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let deactivated = 0
  let restored = 0
  let skipped = 0
  const failures: string[] = []

  for (const entry of overrides) {
    if (!entry.profileKey) {
      skipped++
      continue
    }
    try {
      if (!entry.existed) {
        await postForm(`${base}/api/qualityprofiles/deactivate_rule`, headers, { key: entry.profileKey, rule: entry.ruleKey })
        deactivated++
        continue
      }
      const priorParams = (entry.priorParams ?? [])
        .filter((p) => p.key)
        .map((p) => `${p.key}=${p.value ?? ''}`)
        .join(';')
      await postForm(`${base}/api/qualityprofiles/activate_rule`, headers, {
        key: entry.profileKey,
        rule: entry.ruleKey,
        severity: entry.priorSeverity || undefined,
        params: priorParams || undefined,
        prioritizedRule: entry.priorPrioritized || undefined,
      })
      restored++
    } catch (error) {
      failures.push(`${entry.ruleKey} in ${entry.profileName} (${entry.language}): ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Rollback partially failed: ${deactivated} deactivated, ${restored} restored, ${skipped} skipped (profile unresolved at deploy time). Errors: ${failures.join('; ')}`,
    }
  }
  return {
    success: true,
    message: `Rolled back rule overrides: ${deactivated} deactivated, ${restored} restored${skipped ? `, ${skipped} skipped (profile unresolved at deploy time)` : ''}.`,
  }
}
