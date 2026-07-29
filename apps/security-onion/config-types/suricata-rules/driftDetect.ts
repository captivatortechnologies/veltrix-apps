import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'

/**
 * Drift for Suricata rule state.
 *
 * Security Onion does not expose a reliable per-SID enabled/disabled READ over the
 * command set this app declares (so-rule applies state; there is no verified,
 * stable list output to parse across releases). Rather than guess and raise false
 * drift, this reports no drift. A live read (parsing `so-rule list` / the grid's
 * disabled-sid pillar) is a tracked follow-up once verified against a real grid —
 * at which point each item's declared state is compared to the live state here.
 */
export default async function driftDetect(_ctx: DriftContext): Promise<DriftResult> {
  return { hasDrift: false, diffs: [] }
}
