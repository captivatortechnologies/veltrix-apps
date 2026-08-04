import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import { levelLabel, type NewCodePeriod } from './_shared'

/**
 * Deploy SonarQube new code periods over the Web API (/api/new_code_periods):
 *   read prior: GET  /api/new_code_periods/show[?project=..][&branch=..]  → the current
 *               definition at this level (reflects inheritance when nothing is
 *               explicitly set here)
 *   apply:      POST /api/new_code_periods/set  { type, value?, project?, branch? }
 *
 * The (project, branch) pair addresses the level: blank+blank = global, project only =
 * project level, both = branch level. rollbackData records, per level, whether an
 * explicit override existed before this deploy and what it was, so rollback can restore
 * it exactly, or fall back to inheritance (unset) when this deploy introduced the first
 * override at that level. A failed read-back on one item does not fail the whole deploy —
 * the prior state is simply recorded as unknown and the set proceeds.
 *
 * Verified live against a running SonarQube instance's own `api/webservices` reflection
 * endpoints.
 */
const enc = encodeURIComponent

function showQuery(project: string, branch: string): string {
  const params: string[] = []
  if (project) params.push(`project=${enc(project)}`)
  if (branch) params.push(`branch=${enc(branch)}`)
  return params.length ? `?${params.join('&')}` : ''
}

async function showPeriod(base: string, headers: Record<string, string>, project: string, branch: string): Promise<NewCodePeriod> {
  try {
    return await getJson<NewCodePeriod>(`${base}/api/new_code_periods/show${showQuery(project, branch)}`, headers)
  } catch {
    return { type: undefined }
  }
}

interface RollbackPeriod {
  project: string
  branch: string
  wasExplicit: boolean
  priorType?: string
  priorValue?: string
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for new code period deployment' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const periods: RollbackPeriod[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const project = String(item.fields.project ?? '').trim()
      const branch = String(item.fields.branch ?? '').trim()
      const type = String(item.fields.type ?? '').trim()
      const value = String(item.fields.value ?? '').trim()
      if (!type) continue

      const prior = await showPeriod(base, headers, project, branch)
      const wasExplicit = prior.type !== undefined && prior.inherited !== true

      await postForm(`${base}/api/new_code_periods/set`, headers, {
        type,
        value: value || undefined,
        project: project || undefined,
        branch: branch || undefined,
      })

      periods.push({ project, branch, wasExplicit, priorType: prior.type, priorValue: prior.value })
      applied.push(levelLabel(project, branch))
    }

    return {
      success: true,
      message: `Applied ${applied.length} new code period(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { periods },
    }
  } catch (error) {
    return {
      success: false,
      message: `New code period deploy failed after ${applied.length} period(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { periods },
    }
  }
}
