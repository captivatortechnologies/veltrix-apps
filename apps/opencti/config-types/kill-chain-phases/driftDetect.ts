import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_KILL_CHAIN_PHASES_QUERY, findKillChainPhase, killChainPhasesFromList, normalizeOrder } from './_shared'

/**
 * Drift for kill-chain-phases: compare the order we declare against the live
 * phase in OpenCTI (matched by kill_chain_name + phase_name). Best-effort — a
 * phase that can't be matched (missing / transient error) is skipped rather
 * than raising false drift. Read-only: killChainPhases. Verified against the
 * OpenCTI GraphQL backend schema (opencti-platform/opencti,
 * config/schema/opencti.graphql, type `KillChainPhase`).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = killChainPhasesFromList(await graphql<unknown>(base, headers, LIST_KILL_CHAIN_PHASES_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read kill-chain phases, no drift asserted
  }

  for (const item of items) {
    const killChainName = String(item.fields.kill_chain_name ?? '').trim()
    const phaseName = String(item.fields.phase_name ?? '').trim()
    if (!killChainName || !phaseName) continue
    const match = findKillChainPhase(live, killChainName, phaseName)
    if (!match) continue

    const label = `${killChainName}/${phaseName}`
    const expectedOrder = normalizeOrder(item.fields.x_opencti_order)
    const actualOrder = normalizeOrder(match.x_opencti_order)
    if (expectedOrder !== actualOrder) {
      diffs.push({ field: `${label}.x_opencti_order`, expected: expectedOrder, actual: actualOrder, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
