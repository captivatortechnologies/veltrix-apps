import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import { reconcileConditions, type ParsedCondition, type SonarCondition } from './_shared'

/**
 * Undo a quality-gates deploy from rollbackData (written by deploy()):
 *   - a gate we CREATED (existed=false) is destroyed (POST /api/qualitygates/destroy),
 *     which also removes its conditions.
 *   - a gate that already EXISTED has its condition set restored to the recorded prior
 *     state by reconciling current → prior (create/update/delete_condition).
 *   - the prior default gate is re-selected (POST /api/qualitygates/set_as_default).
 * Built-in gates were never modified, so nothing is restored for them. Applied over
 * the SonarQube Web API. Best-effort — a failure on one gate does not abort the rest.
 */
interface ShowGateResponse {
  conditions?: SonarCondition[]
}

async function currentConditions(base: string, headers: Record<string, string>, name: string): Promise<SonarCondition[]> {
  try {
    const shown = await getJson<ShowGateResponse>(`${base}/api/qualitygates/show?name=${encodeURIComponent(name)}`, headers)
    return Array.isArray(shown.conditions) ? shown.conditions : []
  } catch {
    return []
  }
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    priorDefaultName?: string | null
    gates?: Array<{ name: string; existed: boolean; isBuiltIn: boolean; priorConditions: SonarCondition[] }>
  }
  const gates = data.gates ?? []
  if (gates.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for quality gate rollback' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let removed = 0
  let restored = 0
  let skipped = 0
  const failures: string[] = []

  for (const gate of gates) {
    try {
      if (!gate.existed) {
        await postForm(`${base}/api/qualitygates/destroy`, headers, { name: gate.name })
        removed++
        continue
      }
      if (gate.isBuiltIn) {
        skipped++
        continue
      }
      const desired: ParsedCondition[] = (gate.priorConditions ?? []).map((c) => ({ metric: c.metric, op: String(c.op), error: String(c.error) }))
      const live = await currentConditions(base, headers, gate.name)
      const { toCreate, toUpdate, toDelete } = reconcileConditions(desired, live)
      for (const c of toCreate) {
        await postForm(`${base}/api/qualitygates/create_condition`, headers, { gateName: gate.name, metric: c.metric, op: c.op, error: c.error })
      }
      for (const { live: have, desired: want } of toUpdate) {
        await postForm(`${base}/api/qualitygates/update_condition`, headers, { id: String(have.id ?? ''), metric: want.metric, op: want.op, error: want.error })
      }
      for (const c of toDelete) {
        await postForm(`${base}/api/qualitygates/delete_condition`, headers, { id: String(c.id ?? '') })
      }
      restored++
    } catch (error) {
      failures.push(`${gate.name}: ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  // Restore the gate that was default before the deploy (best-effort).
  if (data.priorDefaultName) {
    try {
      await postForm(`${base}/api/qualitygates/set_as_default`, headers, { name: data.priorDefaultName })
    } catch (error) {
      failures.push(`default(${data.priorDefaultName}): ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rollback partially failed: ${removed} removed, ${restored} restored, ${skipped} skipped. Errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back quality gates: ${removed} removed, ${restored} restored${skipped ? `, ${skipped} skipped (built-in)` : ''}.` }
}
