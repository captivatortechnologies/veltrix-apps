import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage, type PingOneClient } from '../../lib/pingOne'
import { extractPolicySpecs, type LiveMfaDevicePolicy, type MfaDevicePolicySpec } from './validate'

export interface MfaPolicyRollbackEntry {
  name: string
  existed: boolean
  /** The policy id PingOne assigns - the rollback key (never the name). */
  id?: string
  /** Prior policy body with server-managed readOnly fields stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/** Server-managed fields PingOne returns on a policy but that must never be sent back. */
export const READONLY_POLICY_FIELDS = ['id', 'environment', 'updatedAt', '_links', 'forSignOnPolicy'] as const

/**
 * Deploy MFA device authentication policies to a PingOne environment via the
 * Device Authentication Policies API. NO UPSERT exists, so for each declared
 * policy:
 *   - GET  /deviceAuthenticationPolicies      - list (paginated) and match by name
 *   - PUT  /deviceAuthenticationPolicies/{id} - update an existing policy (capture prior body)
 *   - POST /deviceAuthenticationPolicies      - create a missing policy (capture the new id)
 *
 * A policy this canvas does not declare is never touched - deploy is
 * additive and never deletes an out-of-band policy.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, environmentId, region } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: MfaPolicyRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findPolicyByName(client, spec.name)
      const body = buildPolicyBody(spec)

      if (existing?.id) {
        // UPDATE IN PLACE. Capture the prior body (readonly fields stripped)
        // so rollback can PUT it back.
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: stripReadOnlyPolicyFields(existing),
        })

        const res = await client.request('PUT', `/deviceAuthenticationPolicies/${existing.id}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to update MFA device policy "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/deviceAuthenticationPolicies', { body })
        if (!res.ok) {
          throw new Error(`Failed to create MFA device policy "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
        const created = parseJson<LiveMfaDevicePolicy>(res.body)
        if (!created?.id) {
          throw new Error(`MFA device policy "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} MFA device authentication policy(ies) to PingOne environment ${environmentId} (region ${region}): ${deployed.join(', ')}`,
      artifacts: { environmentId, region, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `MFA device policy deployment failed after ${deployed.length} of ${specs.length} polic${
        specs.length === 1 ? 'y' : 'ies'
      }: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { environmentId, region, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Find a policy by exact name across the paginated policy list; null when absent. */
export async function findPolicyByName(client: PingOneClient, name: string): Promise<LiveMfaDevicePolicy | null> {
  const res = await client.getAll<LiveMfaDevicePolicy>('/deviceAuthenticationPolicies', 'deviceAuthenticationPolicies')
  if (!res.ok) {
    throw new Error(
      `Failed to list MFA device policies while resolving "${name}": ${pingOneErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
      })}`,
    )
  }
  return res.items.find((p) => p.name === name) ?? null
}

/** Copy a live policy without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyPolicyFields(policy: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(policy)) {
    if (!(READONLY_POLICY_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}

/** Build one SMS/Voice/Email-shaped channel: `{ enabled, otp: { lifeTime, failure, otpLength } }`. */
function buildOtpChannel(
  enabled: boolean,
  lifetimeSeconds: number,
  failureCount: number,
  coolDownMinutes: number,
  otpLength: number,
): Record<string, unknown> {
  return {
    enabled,
    otp: {
      lifeTime: { duration: lifetimeSeconds, timeUnit: 'SECONDS' },
      failure: { count: failureCount, coolDown: { duration: coolDownMinutes, timeUnit: 'MINUTES' } },
      otpLength,
    },
  }
}

/** TOTP has no `lifeTime` (passcodes are time-based, not server-issued) but adds `passcodeGracePeriod`. */
function buildTotpChannel(spec: MfaDevicePolicySpec): Record<string, unknown> {
  return {
    enabled: spec.totpEnabled,
    otp: {
      failure: { count: spec.totpFailureCount, coolDown: { duration: spec.totpCoolDownMinutes, timeUnit: 'MINUTES' } },
    },
    passcodeGracePeriod: spec.totpPasscodeGracePeriod,
  }
}

/** `fido2` is optional on the API - omitted entirely unless the canvas configured it. */
export function buildFido2Channel(spec: MfaDevicePolicySpec): Record<string, unknown> | undefined {
  if (!spec.fido2Enabled && !spec.fido2PolicyId) return undefined
  const fido2: Record<string, unknown> = { enabled: spec.fido2Enabled }
  if (spec.fido2PolicyId) fido2.fido2PolicyId = spec.fido2PolicyId
  return fido2
}

/**
 * Build the create/update body. `sms`/`voice`/`email`/`totp`/`mobile` are
 * REQUIRED keys on PingOne's model - always sent, even when disabled (an
 * `{enabled:false}` channel still carries its OTP defaults) - while `fido2`
 * is optional and omitted unless configured.
 */
export function buildPolicyBody(spec: MfaDevicePolicySpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    default: spec.default,
    newDeviceNotification: spec.newDeviceNotification,
    authentication: { deviceSelection: spec.deviceSelection },
    ignoreUserLock: spec.ignoreUserLock,
    sms: buildOtpChannel(
      spec.smsEnabled,
      spec.smsOtpLifetimeSeconds,
      spec.smsOtpFailureCount,
      spec.smsOtpCoolDownMinutes,
      spec.smsOtpLength,
    ),
    voice: buildOtpChannel(
      spec.voiceEnabled,
      spec.voiceOtpLifetimeSeconds,
      spec.voiceOtpFailureCount,
      spec.voiceOtpCoolDownMinutes,
      spec.voiceOtpLength,
    ),
    email: buildOtpChannel(
      spec.emailEnabled,
      spec.emailOtpLifetimeSeconds,
      spec.emailOtpFailureCount,
      spec.emailOtpCoolDownMinutes,
      spec.emailOtpLength,
    ),
    totp: buildTotpChannel(spec),
    mobile: { enabled: spec.mobileEnabled },
  }

  const fido2 = buildFido2Channel(spec)
  if (fido2) body.fido2 = fido2

  return body
}
