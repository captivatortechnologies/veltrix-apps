import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, parseJson, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import {
  B2B_SETTING_KEYS,
  canonical,
  extractCrossTenantDefaultSpecs,
  parseObject,
  type LiveCrossTenantDefault,
} from './validate'

const PATH = '/policies/crossTenantAccessPolicy/default'

type Diffs = DriftResult['diffs']

// Per-diff actor attribution (who last changed the live value) is a per-tool
// rollout in this platform and is not wired for Entra yet, so diffs carry no
// actor here — best effort matches the sibling cross-tenant-access-partners type.
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const spec = extractCrossTenantDefaultSpecs(ctx.deployedConfig)[0]
  if (!spec) return { hasDrift: false, diffs: [] }

  const resp = await client.get(PATH)
  if (!resp.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveCrossTenantDefault>(resp.body) ?? {}

  const diffs: Diffs = []
  const trust = live.inboundTrust ?? {}
  const bool = (field: string, want: boolean, actual: boolean | undefined) => {
    if (want !== (actual === true)) {
      diffs.push({ field, expected: String(want), actual: String(actual === true), severity: 'warning' })
    }
  }

  bool('inboundTrust.isMfaAccepted', spec.inboundTrustMfa, trust.isMfaAccepted)
  bool('inboundTrust.isCompliantDeviceAccepted', spec.inboundTrustCompliantDevice, trust.isCompliantDeviceAccepted)
  bool(
    'inboundTrust.isHybridAzureADJoinedDeviceAccepted',
    spec.inboundTrustHybridJoined,
    trust.isHybridAzureADJoinedDeviceAccepted,
  )

  // Only surface auto-consent drift when the author opted in — Graph keeps these
  // false on the default policy, so an opted-in value legitimately shows as drift.
  if (spec.autoConsentInbound || spec.autoConsentOutbound) {
    const auto = live.automaticUserConsentSettings ?? {}
    bool('automaticUserConsentSettings.inboundAllowed', spec.autoConsentInbound, auto.inboundAllowed ?? false)
    bool('automaticUserConsentSettings.outboundAllowed', spec.autoConsentOutbound, auto.outboundAllowed ?? false)
  }

  const blocks = spec.b2bCollaboration ? parseObject(spec.b2bCollaboration) : null
  if (blocks) {
    for (const key of Object.keys(blocks)) {
      if (!B2B_SETTING_KEYS.has(key)) continue
      const want = canonical(blocks[key])
      const actual = canonical(live[key])
      if (want !== actual) {
        diffs.push({ field: key, expected: want, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
