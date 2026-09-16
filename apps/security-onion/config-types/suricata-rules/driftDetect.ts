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
  // `checked: false` (SDK 3.9.0): this handler cannot read the live state, so
  // it makes no claim. Without it, `hasDrift: false` reads as a positive
  // assurance and the platform marks outstanding drift for this component
  // resolved with `drift_cleared` — turning "could not look" into "looked and
  // it is fine", and clearing real drift on every scheduled run.
  return { hasDrift: false, diffs: [], checked: false }
}
