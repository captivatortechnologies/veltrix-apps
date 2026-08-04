import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, parseJson, JUMPCLOUD_API_BASE, type JumpCloudClient } from '../../lib/jumpcloudApi'
import { extractCommandSpecs, buildCommandBody, findCommandByName, priorFieldsOf, type JumpCloudCommand } from './_shared'

/** One rollback record per applied Command. */
export interface CommandRollbackEntry {
  name: string
  /** Whether the command already existed (update) or was created by this deploy. */
  existed: boolean
  id?: string
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/**
 * Deploy JumpCloud Commands over the API v1 (/commands):
 *   list:   GET  /commands                     ({ results, totalCount } wrapper; match candidates by name)
 *   update: PUT  /commands/{id}  with the Command body
 *   create: POST /commands       with the Command body
 *
 * The name is the stable identity used to upsert. Matching is RENAME-SAFE via the
 * per-item resourceIds map (same pattern as the other JumpCloud config types).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJumpCloudClient(ctx.credential, ctx.settings, { baseUrl: JUMPCLOUD_API_BASE })
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractCommandSpecs(ctx.canvas).filter((s) => s.name)
  const previousState: CommandRollbackEntry[] = []
  const createdIds: string[] = []
  const applied: string[] = []
  const resourceIds: Record<string, string> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    const liveCommands = await listCommands(client)

    for (const spec of specs) {
      let existing: JumpCloudCommand | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getCommandById(client, priorId)
      if (!existing) existing = findCommandByName(liveCommands, spec.name)

      const body = buildCommandBody(spec)
      let commandId: string

      if (existing?._id) {
        commandId = existing._id
        previousState.push({ name: spec.name, existed: true, id: commandId, prior: priorFieldsOf(existing) })
        const res = await client.request('PUT', `/commands/${encodeURIComponent(commandId)}`, { body })
        if (!res.ok) throw new Error(`Failed to update Command "${spec.name}": ${jumpCloudErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/commands', { body })
        if (!res.ok) throw new Error(`Failed to create Command "${spec.name}": ${jumpCloudErrorMessage(res)}`)
        const created = parseJson<JumpCloudCommand>(res.body)
        if (!created?._id) throw new Error(`Command "${spec.name}" was created but the API returned no id`)
        commandId = created._id
        createdIds.push(commandId)
        previousState.push({ name: spec.name, existed: false, id: commandId })
      }

      if (spec.itemId) resourceIds[spec.itemId] = commandId
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Command(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Command deploy failed after ${applied.length} of ${specs.length} command(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds: { ...priorResourceIds, ...resourceIds } },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every Command in the org, following pagination over the v1 { results, totalCount } wrapper. */
export async function listCommands(client: JumpCloudClient): Promise<JumpCloudCommand[]> {
  const res = await client.listAllV1<JumpCloudCommand>('/commands')
  if (!res.ok) {
    throw new Error(`Failed to list Commands: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Fetch a Command by id, or null on 404 / any non-ok (a stale stored id falls back to name matching). */
export async function getCommandById(client: JumpCloudClient, id: string): Promise<JumpCloudCommand | null> {
  const res = await client.request('GET', `/commands/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const command = parseJson<JumpCloudCommand>(res.body)
  return command?._id ? command : null
}

/**
 * Read the canvas-item-id -> command-id map this canvas stored on its last
 * SUCCEEDED deploy (rollbackData.resourceIds). Best-effort — {} on no prior
 * deploy or a read error.
 */
async function readPriorResourceIds(ctx: DeployContext): Promise<Record<string, string>> {
  try {
    const prior = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const rb = prior?.rollbackData as { resourceIds?: Record<string, string> } | undefined
    return rb?.resourceIds ?? {}
  } catch {
    return {}
  }
}
