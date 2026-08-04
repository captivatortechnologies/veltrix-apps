import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import {
  buildFieldBody,
  buildFieldId,
  fieldsOfKind,
  isProtectedField,
  listFields,
  saveField,
  type LiveField,
} from '../lib/xsoarFields'
import { extractFieldSpecs } from './validate'

const KIND = 'indicator' as const

export interface IndicatorFieldRollbackEntry {
  cliName: string
  id: string
  existed: boolean
  prior?: LiveField
}

/**
 * Deploy Cortex XSOAR indicator fields via the server REST API.
 *
 * Identity is the field CLINAME (its server id is derived as
 * "indicator_<cliName>"). List every field (GET /incidentfields, shared with
 * incident fields), match on the derived id, then upsert with
 * POST /incidentfields/import. Built-in / locked fields are never modified.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, serverUrl } = built

  const specs = extractFieldSpecs(ctx.canvas).filter((s) => s.cliName)
  const rollbackState: IndicatorFieldRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const existing = fieldsOfKind(await listFields(client), KIND)
    const byId = new Map(existing.filter((f) => f.id).map((f) => [f.id as string, f]))

    for (const spec of specs) {
      const id = buildFieldId(KIND, spec.cliName)
      const live = byId.get(id) ?? null

      if (live && isProtectedField(live)) {
        throw new Error(`Indicator field "${spec.cliName}" is a built-in/locked field and cannot be modified`)
      }

      const body = buildFieldBody(KIND, spec, live)
      await saveField(client, body)
      rollbackState.push({ cliName: spec.cliName, id, existed: live !== null, prior: live ?? undefined })
      deployed.push(spec.cliName)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} indicator field(s) to ${serverUrl}: ${deployed.join(', ')}`,
      artifacts: { serverUrl, deployedFields: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Indicator field deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { serverUrl, deployedFields: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}
