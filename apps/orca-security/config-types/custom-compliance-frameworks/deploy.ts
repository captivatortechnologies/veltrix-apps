import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { dataFromEnvelope, parseJsonField, priorServerId, readPriorRollback } from '../../lib/reconcile'
import {
  buildFrameworkBody,
  type ComplianceFrameworkRollbackData,
  type ComplianceFrameworkRollbackEntry,
  type FrameworkSection,
  type OrcaComplianceFrameworkBody,
  type OrcaComplianceFrameworkWriteResponse,
} from './_shared'

/**
 * Deploy Orca custom compliance frameworks over the REST API:
 *   read prior ids: ctx.platform.getLatestDeployment().rollbackData
 *   confirm exists: GET  /api/compliance/frameworks/{id}   (name/description only — no sections)
 *   create:         POST /api/compliance/frameworks        -> { data: { id } }
 *   update:         PUT  /api/compliance/frameworks/{id}
 *
 * Orca has no documented "list frameworks" endpoint, so identity is the
 * framework id this app ASSIGNS on create and PERSISTS in rollbackData —
 * recovered on the next deploy by the stable canvas item id first (so a rename
 * updates the same framework) then by name.
 *
 * UNLIKE every other config type in this app, rollbackData.previous[].prior is
 * NOT a live-read body — Orca's read endpoint never returns sections/tests, so
 * there is nothing live to capture. Instead, `prior` carries the FULL BODY this
 * app is about to apply for an item that already existed, taken from the
 * canvas being deployed now. That means rollback restores the state from
 * *before this specific deploy* is only correct when combined with the
 * previous deploy's own rollbackData chain — the same limitation the official
 * Orca Terraform provider documents ("Terraform preserves the last-applied
 * value in state"). See _shared.ts for the full explanation.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const previousData = await readPriorRollback<OrcaComplianceFrameworkBody>(ctx)

  const previous: ComplianceFrameworkRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const itemId = item.id ?? ''
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const sectionsField = parseJsonField<FrameworkSection[]>(item.fields.sections, 'Sections')
      if (!sectionsField.ok) throw new Error(`compliance framework "${name}": ${sectionsField.error}`)

      const knownId = priorServerId(previousData.previous, itemId, name)
      const stillExists = knownId ? await frameworkExists(client, knownId) : false

      if (knownId && stillExists) {
        // The prior deploy's own recorded body is the best available "before"
        // snapshot — Orca cannot echo sections back for us to capture instead.
        const priorBody = previousData.previous?.find((p) => p.serverId === knownId)?.prior ?? null
        const body = buildFrameworkBody(item.fields, sectionsField.value, false)
        const res = await client.request<unknown>('PUT', `/api/compliance/frameworks/${encodeURIComponent(knownId)}`, body)
        if (res.error) throw new Error(`update compliance framework "${name}" failed: ${res.error}`)
        previous.push({ itemId, name, serverId: knownId, existed: true, prior: priorBody ?? body })
      } else {
        const body = buildFrameworkBody(item.fields, sectionsField.value, true)
        const res = await client.request<unknown>('POST', '/api/compliance/frameworks', body)
        if (res.error) throw new Error(`create compliance framework "${name}" failed: ${res.error}`)
        const created = dataFromEnvelope<OrcaComplianceFrameworkWriteResponse>(res.data)
        const newId = created?.id != null ? String(created.id) : null
        previous.push({ itemId, name, serverId: newId, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} custom compliance framework(s) to ${baseUrl}: ${applied.join(', ') || '(none)'}`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies ComplianceFrameworkRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom compliance framework deploy failed after ${applied.length} of ${items.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies ComplianceFrameworkRollbackData,
    }
  }
}

/** HEAD-equivalent existence check via GET — true when the framework can still be read. */
async function frameworkExists(client: OrcaClient, id: string): Promise<boolean> {
  const res = await client.request<unknown>('GET', `/api/compliance/frameworks/${encodeURIComponent(id)}`)
  return res.ok
}
