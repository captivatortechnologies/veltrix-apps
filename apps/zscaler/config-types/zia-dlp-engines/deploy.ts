import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import { extractDlpEngineSpecs, type DlpEngineSpec, type LiveDlpEngine } from './validate'

export interface EngineRollbackEntry {
  name: string
  existed: boolean
  id?: number
  prior?: {
    name?: string
    description?: string
    engineExpression?: string
    customDlpEngine?: boolean
  }
}

/**
 * Deploy custom ZIA DLP engines via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /dlpEngines, match by name, then
 * PUT an existing engine or POST a new one. ZIA STAGES every write — nothing takes
 * effect until activation — so this writes all engines, then calls activate() ONCE
 * at the end. If activation fails the writes remain staged and rollbackData is
 * returned so the platform can revert them.
 *
 * PREDEFINED (built-in) DLP engines are read-only: if a name matches a live engine
 * whose customDlpEngine is false, deploy throws so the author renames rather than
 * attempting to overwrite a built-in.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractDlpEngineSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: EngineRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listDlpEngines(client)
    const byName = new Map(existing.filter((e) => e.name).map((e) => [e.name as string, e]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && live.customDlpEngine === false) {
        throw new Error(
          `"${spec.name}" is a predefined DLP engine and cannot be modified — rename your engine to manage a custom one`,
        )
      }

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            name: live.name,
            description: live.description ?? '',
            engineExpression: live.engineExpression ?? '',
            customDlpEngine: live.customDlpEngine,
          },
        })
        const res = await client.zia('PUT', `/dlpEngines/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update DLP engine "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/dlpEngines', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create DLP engine "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveDlpEngine>(res.body)
        if (created?.id == null) {
          throw new Error(`DLP engine "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA DLP engine(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedEngines: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA DLP engine(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedEngines: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `DLP engine deployment failed after ${deployed.length} of ${specs.length} engine(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedEngines: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA DLP engines; throws on a non-OK response. */
export async function listDlpEngines(client: ZscalerClient): Promise<LiveDlpEngine[]> {
  const res = await client.ziaGetAll<LiveDlpEngine>('/dlpEngines')
  if (!res.ok) {
    throw new Error(
      `Failed to list DLP engines: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a DLP engine by name; null when absent. */
export async function findDlpEngine(client: ZscalerClient, name: string): Promise<LiveDlpEngine | null> {
  const all = await listDlpEngines(client)
  return all.find((e) => e.name === name) ?? null
}

function buildPayload(spec: DlpEngineSpec): Record<string, unknown> {
  // description always sent (even empty) so clearing it converges the live engine.
  return {
    name: spec.name,
    description: spec.description ?? '',
    engineExpression: spec.engineExpression,
    // Managed engines are always custom (predefined engines are read-only).
    customDlpEngine: spec.customDlpEngine,
  }
}
