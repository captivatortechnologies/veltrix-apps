import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, postForm } from '../../lib/sonarqubeApi'
import { levelLabel } from './_shared'

/**
 * Undo a new-code-periods deploy from rollbackData (written by deploy()):
 *   - a level that had an EXPLICIT override before this deploy (wasExplicit=true) has it
 *     restored exactly (POST /api/new_code_periods/set with the recorded prior type/value).
 *   - a level that was INHERITING before this deploy (wasExplicit=false) has the override
 *     this deploy introduced removed (POST /api/new_code_periods/unset), falling back to
 *     inheritance again.
 * Best-effort — a failure on one level does not abort the rest. Applied over the
 * SonarQube Web API.
 *
 * Verified live against a running SonarQube instance's own `api/webservices` reflection
 * endpoints.
 */
interface RollbackPeriod {
  project: string
  branch: string
  wasExplicit: boolean
  priorType?: string
  priorValue?: string
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { periods?: RollbackPeriod[] }
  const periods = data.periods ?? []
  if (periods.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for new code period rollback' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let reverted = 0
  const failures: string[] = []

  for (const period of periods) {
    const label = levelLabel(period.project, period.branch)
    try {
      if (period.wasExplicit) {
        await postForm(`${base}/api/new_code_periods/set`, headers, {
          type: period.priorType,
          value: period.priorValue || undefined,
          project: period.project || undefined,
          branch: period.branch || undefined,
        })
        restored++
      } else {
        await postForm(`${base}/api/new_code_periods/unset`, headers, {
          project: period.project || undefined,
          branch: period.branch || undefined,
        })
        reverted++
      }
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rollback partially failed: ${restored} restored, ${reverted} reverted to inherited. Errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back new code periods: ${restored} restored, ${reverted} reverted to inherited.` }
}
