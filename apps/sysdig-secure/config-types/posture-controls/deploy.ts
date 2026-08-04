import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, priorExternalIds, type ExternalIdMap, type SysdigPostureControl } from '../../lib/sysdigApi'
import { buildControlBody, normalizeBoolean } from './_shared'

/**
 * Deploy Sysdig Secure posture controls over the REST API:
 *   apply:  POST   /api/cspm/v1/policy/controls        (upsert — id present = update, absent = create)
 *   get:    GET    /api/cspm/v1/policy/controls/view/<id>
 *   remove: DELETE /api/cspm/v1/policy/controls/<id>    (for a disabled control)
 *
 * Posture Controls have NO list/search-by-name endpoint (confirmed against
 * terraform-provider-sysdig — only CRUD by id), so this app cannot rediscover
 * a control's live id by name on a later deploy the way it does for Falco
 * rules. Instead it persists {canvas item id -> external id} in
 * DeployResult.rollbackData and reads it back on the NEXT deploy via
 * ctx.platform.getLatestDeployment() — exactly the pattern the SDK's
 * DeploymentSummary.rollbackData doc describes for id-only APIs.
 */
type ControlAction = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: ControlAction
  controlId: string | null
  prior: SysdigPostureControl | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const priorDeployment = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
  const priorIds = priorExternalIds(priorDeployment?.rollbackData)
  const externalIds: ExternalIdMap = {}

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const itemId = item.id ?? name
      const enabled = normalizeBoolean(item.fields.enabled, true)
      const priorId = priorIds[itemId]?.externalId ?? null

      let prior: SysdigPostureControl | null = null
      if (priorId) {
        try {
          prior = await client.getPostureControlById(priorId)
        } catch {
          prior = null
        }
      }

      if (!enabled) {
        if (priorId) {
          await client.deletePostureControlById(priorId)
          previous.push({ name, action: 'deleted', controlId: priorId, prior })
        } else {
          previous.push({ name, action: 'noop', controlId: null, prior: null })
        }
        applied.push(`${name} (removed)`)
        continue
      }

      const body = buildControlBody(item.fields, prior ? priorId ?? undefined : undefined)
      const saved = await client.createOrUpdatePostureControl(body)
      const savedId = saved.id ?? priorId ?? undefined
      if (savedId) externalIds[itemId] = { externalId: savedId, name }
      previous.push({ name, action: prior ? 'updated' : 'created', controlId: savedId ?? null, prior })
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} posture control(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous, externalIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Posture control deploy failed after ${applied.length} control(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous, externalIds },
    }
  }
}
