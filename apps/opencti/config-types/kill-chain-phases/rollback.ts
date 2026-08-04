import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_KILL_CHAIN_PHASE_MUTATION, PATCH_KILL_CHAIN_PHASE_MUTATION, buildRestorePatch, type OpenctiKillChainPhase } from './_shared'

/**
 * Undo a kill-chain-phases deploy from rollbackData.previous (written by
 * deploy()): for each entry with a prior body, killChainPhaseEdit(id) {
 * fieldPatch(input) } restores it; a newly created phase (prior body null) is
 * deleted via killChainPhaseEdit(id) { delete }. Applied over the OpenCTI
 * GraphQL API. Verified against the OpenCTI GraphQL backend schema
 * (opencti-platform/opencti, config/schema/opencti.graphql, type
 * `KillChainPhase`).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ killChainName: string; phaseName: string; phaseId: string | null; phase: OpenctiKillChainPhase | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for kill-chain-phase rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { phaseId, phase } of previous) {
      if (phaseId == null) {
        // A created phase whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (phase) {
        const input = buildRestorePatch(phase)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_KILL_CHAIN_PHASE_MUTATION, { id: phaseId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_KILL_CHAIN_PHASE_MUTATION, { id: phaseId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back kill-chain phases: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
