import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_KILL_CHAIN_PHASE_MUTATION,
  LIST_KILL_CHAIN_PHASES_QUERY,
  PATCH_KILL_CHAIN_PHASE_MUTATION,
  buildKillChainPhaseInput,
  buildKillChainPhasePatch,
  findKillChainPhase,
  killChainPhasesFromList,
  type OpenctiKillChainPhase,
} from './_shared'

/**
 * Deploy OpenCTI kill-chain phases over the GraphQL API:
 *   read (rollback): killChainPhases                          → find the live phase by kill_chain_name + phase_name
 *   create:          killChainPhaseAdd(input) with { kill_chain_name, phase_name, x_opencti_order }
 *   update:          killChainPhaseEdit(id) { fieldPatch(input) } with [EditInput] (phase exists)
 *
 * `kill_chain_name` + `phase_name` together are the stable compound identity used
 * to upsert. rollbackData records, per phase, the prior phase node (null when it
 * did not exist) AND the phase id — so rollback can restore the prior body or
 * delete the one we created.
 *
 * NOTE: killChainPhaseAdd returns the created phase (with its new id). Verified
 * against the OpenCTI GraphQL backend schema (opencti-platform/opencti,
 * config/schema/opencti.graphql, type `KillChainPhase`).
 */
async function listKillChainPhases(base: string, headers: Record<string, string>): Promise<OpenctiKillChainPhase[]> {
  try {
    return killChainPhasesFromList(await graphql<unknown>(base, headers, LIST_KILL_CHAIN_PHASES_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for kill-chain-phase deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{
    killChainName: string
    phaseName: string
    phaseId: string | null
    phase: OpenctiKillChainPhase | null
  }> = []
  const applied: string[] = []

  try {
    const live = await listKillChainPhases(base, headers)

    for (const item of items) {
      const killChainName = String(item.fields.kill_chain_name ?? '').trim()
      const phaseName = String(item.fields.phase_name ?? '').trim()
      if (!killChainName || !phaseName) continue

      const existing = findKillChainPhase(live, killChainName, phaseName)

      if (existing && existing.id != null) {
        const input = buildKillChainPhasePatch(item.fields)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_KILL_CHAIN_PHASE_MUTATION, { id: existing.id, input })
        }
        previous.push({ killChainName, phaseName, phaseId: String(existing.id), phase: existing })
      } else {
        const created = await graphql<{ killChainPhaseAdd?: OpenctiKillChainPhase }>(
          base,
          headers,
          ADD_KILL_CHAIN_PHASE_MUTATION,
          { input: buildKillChainPhaseInput(item.fields) },
        )
        const newId = created?.killChainPhaseAdd?.id ?? null
        previous.push({ killChainName, phaseName, phaseId: newId ? String(newId) : null, phase: null })
      }
      applied.push(`${killChainName}/${phaseName}`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} kill-chain phase(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Kill-chain-phase deploy failed after ${applied.length} phase(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
