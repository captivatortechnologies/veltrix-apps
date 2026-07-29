import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'

/**
 * Drift for SOC user state.
 *
 * Security Onion does not expose a reliable per-user enabled/disabled READ over the
 * command set this app declares (so-user applies state; there is no verified, stable
 * list output to parse across releases). Rather than guess and raise false drift,
 * this reports no drift. A live read (parsing the grid's user pillar / so-user list)
 * is a tracked follow-up once verified against a real grid — at which point each
 * item's declared state is compared to the live state here.
 */
export default async function driftDetect(_ctx: DriftContext): Promise<DriftResult> {
  return { hasDrift: false, diffs: [] }
}
