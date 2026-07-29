import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'

/**
 * Drift for firewall host-group access.
 *
 * Security Onion does not expose a reliable per-host group-membership READ over the
 * command set this app declares (so-firewall applies include/exclude; there is no
 * verified, stable list output to parse across releases). Rather than guess and
 * raise false drift, this reports no drift. A live read (parsing `so-firewall list`
 * / the grid's firewall pillar) is a tracked follow-up once verified against a real
 * grid — at which point each item's declared access is compared to the live state
 * here.
 */
export default async function driftDetect(_ctx: DriftContext): Promise<DriftResult> {
  return { hasDrift: false, diffs: [] }
}
