import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import {
  parseConditions,
  dedupeByMetric,
  normalizeBool,
  gatesFromList,
  findGate,
  defaultGateName,
  reconcileConditions,
  type SonarCondition,
  type SonarQualityGate,
} from './_shared'

/**
 * Deploy SonarQube quality gates over the Web API (/api/qualitygates):
 *   list (context):  GET  /api/qualitygates/list          → find the gate + prior default
 *   create:          POST /api/qualitygates/create        (gate absent)   { name }
 *   read conditions: GET  /api/qualitygates/show?name=..  → prior conditions (rollback)
 *   reconcile:       POST /api/qualitygates/create_condition | update_condition | delete_condition
 *   default:         POST /api/qualitygates/set_as_default { name }        (when isDefault)
 *
 * The gate NAME is the stable identity used to upsert. Conditions are reconciled by
 * metric (SonarQube allows one condition per metric). rollbackData records, per gate,
 * whether it existed and its prior condition set — plus the prior default gate name —
 * so rollback can restore the prior state or remove a gate we created.
 *
 * SonarQube's built-in gate ("Sonar way") cannot have its conditions edited; such a
 * gate's condition sync is skipped (it can still be set as default).
 */
interface CreateGateResponse {
  id?: string | number
  name?: string
}
interface ShowGateResponse {
  id?: string | number
  name?: string
  isBuiltIn?: boolean
  conditions?: SonarCondition[]
}

async function listGates(base: string, headers: Record<string, string>): Promise<SonarQualityGate[]> {
  try {
    return gatesFromList(await getJson<unknown>(`${base}/api/qualitygates/list`, headers))
  } catch {
    return []
  }
}

async function showGate(base: string, headers: Record<string, string>, name: string): Promise<ShowGateResponse | null> {
  try {
    return await getJson<ShowGateResponse>(`${base}/api/qualitygates/show?name=${encodeURIComponent(name)}`, headers)
  } catch {
    return null
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for quality gate deployment' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const gates: Array<{ name: string; existed: boolean; isBuiltIn: boolean; priorConditions: SonarCondition[] }> = []
  const applied: string[] = []

  try {
    const live = await listGates(base, headers)
    const priorDefaultName = defaultGateName(live)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const { conditions: parsed } = parseConditions(item.fields.conditions)
      const { conditions: desired } = dedupeByMetric(parsed)
      const wantDefault = normalizeBool(item.fields.isDefault)

      const existing = findGate(live, name)
      const existed = existing != null

      if (!existed) {
        await postForm<CreateGateResponse>(`${base}/api/qualitygates/create`, headers, { name })
      }

      // Prior state (conditions + built-in flag), read AFTER a create so a fresh gate
      // reports its (empty) condition set and never a stale one.
      const shown = await showGate(base, headers, name)
      const priorConditions = Array.isArray(shown?.conditions) ? shown!.conditions : []
      const isBuiltIn = shown?.isBuiltIn === true

      if (isBuiltIn) {
        gates.push({ name, existed, isBuiltIn, priorConditions })
        if (wantDefault) await postForm(`${base}/api/qualitygates/set_as_default`, headers, { name })
        applied.push(`${name} (built-in: default only)`)
        continue
      }

      const { toCreate, toUpdate, toDelete } = reconcileConditions(desired, priorConditions)
      for (const c of toCreate) {
        await postForm(`${base}/api/qualitygates/create_condition`, headers, { gateName: name, metric: c.metric, op: c.op, error: c.error })
      }
      for (const { live: have, desired: want } of toUpdate) {
        await postForm(`${base}/api/qualitygates/update_condition`, headers, { id: String(have.id ?? ''), metric: want.metric, op: want.op, error: want.error })
      }
      for (const c of toDelete) {
        await postForm(`${base}/api/qualitygates/delete_condition`, headers, { id: String(c.id ?? '') })
      }

      if (wantDefault) await postForm(`${base}/api/qualitygates/set_as_default`, headers, { name })

      gates.push({ name, existed, isBuiltIn, priorConditions })
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} quality gate(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { priorDefaultName, gates },
    }
  } catch (error) {
    return {
      success: false,
      message: `Quality gate deploy failed after ${applied.length} gate(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { priorDefaultName: defaultGateName(await listGates(base, headers)), gates },
    }
  }
}
