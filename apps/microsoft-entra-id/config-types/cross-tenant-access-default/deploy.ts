import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  B2B_SETTING_KEYS,
  extractCrossTenantDefaultSpecs,
  parseObject,
  type CrossTenantDefaultSpec,
  type LiveCrossTenantDefault,
} from './validate'

/** The cross-tenant access default policy is a tenant-wide singleton. */
export const PATH = '/policies/crossTenantAccessPolicy/default'

export interface RollbackEntry {
  /** Always true — the default policy always exists (update-only, never created). */
  existed: boolean
  /** True when the live policy was still the untouched system default before deploy. */
  wasServiceDefault: boolean
  /** The FULL prior policy body (for a faithful restore). */
  previousState: Record<string, unknown>
}

/** Build the PATCH body from the declared fields — merge semantics, only what we manage. */
export function buildBody(spec: CrossTenantDefaultSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    inboundTrust: {
      isMfaAccepted: spec.inboundTrustMfa,
      isCompliantDeviceAccepted: spec.inboundTrustCompliantDevice,
      isHybridAzureADJoinedDeviceAccepted: spec.inboundTrustHybridJoined,
    },
  }

  // automaticUserConsentSettings is read-only on the default policy, so only
  // attempt it when the author explicitly opts in — a default deploy never
  // touches it and never trips the Graph read-only rejection.
  if (spec.autoConsentInbound || spec.autoConsentOutbound) {
    body.automaticUserConsentSettings = {
      inboundAllowed: spec.autoConsentInbound,
      outboundAllowed: spec.autoConsentOutbound,
    }
  }

  const blocks = spec.b2bCollaboration ? parseObject(spec.b2bCollaboration) : null
  if (blocks) {
    for (const key of Object.keys(blocks)) {
      if (B2B_SETTING_KEYS.has(key)) body[key] = blocks[key]
    }
  }

  return body
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const spec = extractCrossTenantDefaultSpecs(ctx.canvas)[0]
  if (!spec) {
    return { success: true, message: 'No cross-tenant default policy configured', rollbackData: { entries: [] } }
  }

  const getResp = await client.get(PATH)
  if (!getResp.ok) {
    return { success: false, message: `Failed to read cross-tenant default policy: ${graphErrorMessage(getResp)}` }
  }
  const live = parseJson<LiveCrossTenantDefault>(getResp.body) ?? {}

  const resp = await client.patch(PATH, buildBody(spec))
  if (!resp.ok) {
    return { success: false, message: `Failed to update cross-tenant default policy: ${graphErrorMessage(resp)}` }
  }

  const entries: RollbackEntry[] = [
    {
      existed: true,
      wasServiceDefault: live.isServiceDefault === true,
      previousState: live as Record<string, unknown>,
    },
  ]
  return { success: true, message: 'Updated the cross-tenant access default policy', rollbackData: { entries } }
}
