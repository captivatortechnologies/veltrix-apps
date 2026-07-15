import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildVaultClient,
  parseJson,
  vaultErrorMessage,
  type VaultClient,
} from '../../lib/vault'
import {
  extractMfaMethodSpecs,
  type LiveMfaMethod,
  type MfaMethodSpec,
  type MfaMethodType,
} from './validate'

export interface MfaMethodRollbackEntry {
  methodName: string
  type: MfaMethodType
  /** false = deploy CREATED this method (rollback deletes it). */
  existed: boolean
  /** The server-assigned method_id — the stable rollback key (never the name). */
  methodId?: string
  /**
   * Prior NON-SECRET body captured before an update, replayed on rollback.
   * The write-only secrets (integration_key, secret_key, api_token,
   * settings_file_base64) are deliberately absent — Vault never returns them, so
   * they can be neither captured nor restored (see rollback.ts).
   */
  priorBody?: Record<string, unknown>
}

/**
 * Deploy Vault login MFA methods via the /identity/mfa/method/{type} API.
 *
 * CREATE IS NOT UPSERT — POSTing to /{type} twice mints TWO methods. The
 * method's real identity is a server-assigned `method_id` UUID with NO
 * name-in-path form, so deploy reconciles on the `method_name` LABEL instead:
 *
 *   1. LIST /identity/mfa/method/{type}            → the type's method_id keys
 *   2. GET  /identity/mfa/method/{type}/{id} each  → find the one whose
 *                                                    method_name equals the spec's
 *   3a. FOUND  → POST /identity/mfa/method/{type}/{method_id}   (update in place;
 *               capture the prior non-secret body for rollback)
 *   3b. ABSENT → POST /identity/mfa/method/{type}               (create; capture
 *               the new method_id in createdIds)
 *
 * WRITE-ONLY SECRETS are re-sent on BOTH create and update — they can never be
 * read back to compare, so config-as-code always re-asserts them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractMfaMethodSpecs(ctx.canvas).filter((s) => s.methodName && s.type)
  const rollbackState: MfaMethodRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const type = spec.type as MfaMethodType
      const body = buildMethodBody(spec)

      // Reconcile by method_name: LIST the type, GET each, match the label.
      const existing = await findMethodByName(client, type, spec.methodName)

      if (existing && existing.method_id) {
        // UPDATE — capture the prior NON-SECRET fields first so rollback can
        // restore them (the secrets can't be read back, so they're not captured).
        rollbackState.push({
          methodName: spec.methodName,
          type,
          existed: true,
          methodId: existing.method_id,
          priorBody: buildPriorBody(existing),
        })

        const res = await client.request(
          'POST',
          `/identity/mfa/method/${type}/${existing.method_id}`,
          { body },
        )
        if (!res.ok) {
          throw new Error(`Failed to update MFA method "${spec.methodName}" (${type}): ${vaultErrorMessage(res)}`)
        }
      } else {
        // CREATE — POST to the bare /{type} path mints a NEW method_id. Capture
        // it (totp returns it as `id`, the others as `method_id`).
        const res = await client.request('POST', `/identity/mfa/method/${type}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to create MFA method "${spec.methodName}" (${type}): ${vaultErrorMessage(res)}`)
        }
        const newId = parseCreatedId(res.body)
        if (!newId) {
          throw new Error(`MFA method "${spec.methodName}" (${type}) was created but the API returned no method_id`)
        }
        rollbackState.push({ methodName: spec.methodName, type, existed: false, methodId: newId })
        createdIds.push(newId)
      }

      deployed.push(spec.methodName)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} MFA method(s) to Vault at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedMethods: deployed, createdMethodIds: createdIds },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `MFA method deployment failed after ${deployed.length} of ${specs.length} method(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedMethods: deployed, createdMethodIds: createdIds },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with driftDetect / healthCheck) --------------------------

/** List the method_id keys for a type; [] when none exist yet (LIST 404). */
export async function listMethodIds(client: VaultClient, type: MfaMethodType): Promise<string[]> {
  const res = await client.request('LIST', `/identity/mfa/method/${type}`)
  if (res.status === 404) return []
  if (!res.ok) {
    throw new Error(`Failed to list ${type} MFA methods: ${vaultErrorMessage(res)}`)
  }
  const parsed = parseJson<{ data?: { keys?: string[] } }>(res.body)
  return parsed?.data?.keys ?? []
}

/** Read one method by its method_id; null on 404. Normalizes `id`/`method_id`. */
export async function getMethod(
  client: VaultClient,
  type: MfaMethodType,
  methodId: string,
): Promise<LiveMfaMethod | null> {
  const res = await client.request('GET', `/identity/mfa/method/${type}/${methodId}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read ${type} MFA method ${methodId}: ${vaultErrorMessage(res)}`)
  }
  const parsed = parseJson<{ data?: LiveMfaMethod } & LiveMfaMethod>(res.body)
  const data = parsed?.data ?? parsed ?? null
  if (!data) return null
  return { ...data, method_id: data.method_id ?? data.id ?? methodId }
}

/**
 * Find the method of `type` whose `method_name` matches — the whole point of the
 * reconciliation, since a method has no addressable name. LISTs the type, GETs
 * each id and returns the FIRST label match (or null when absent). Because
 * create is not upsert, a tenant could hold two methods with the same name;
 * matching the first keeps deploy deterministic and never mints a duplicate for
 * a name that already exists.
 */
export async function findMethodByName(
  client: VaultClient,
  type: MfaMethodType,
  methodName: string,
): Promise<LiveMfaMethod | null> {
  const ids = await listMethodIds(client, type)
  for (const id of ids) {
    const live = await getMethod(client, type, id)
    if (live && (live.method_name ?? '') === methodName) return live
  }
  return null
}

/** Extract the minted method_id from a create response (totp uses `id`). */
export function parseCreatedId(body: string): string | undefined {
  const parsed = parseJson<{ data?: { method_id?: string; id?: string } }>(body)
  const id = parsed?.data?.method_id ?? parsed?.data?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Build the POST body for a method (create AND update use the same shape). Only
 * the fields the spec sets are sent, but the WRITE-ONLY secrets are ALWAYS
 * re-asserted for the chosen type — they can't be read back to compare, so the
 * canvas is the source of truth every deploy.
 */
export function buildMethodBody(spec: MfaMethodSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { method_name: spec.methodName }

  switch (spec.type) {
    case 'totp':
      // totp has NO secret input — its config is fully readable.
      body.issuer = spec.issuer
      if (spec.period !== undefined) body.period = spec.period
      if (spec.keySize !== undefined) body.key_size = spec.keySize
      if (spec.algorithm) body.algorithm = spec.algorithm
      if (spec.digits !== undefined) body.digits = spec.digits
      if (spec.skew !== undefined) body.skew = spec.skew
      if (spec.maxValidationAttempts !== undefined) body.max_validation_attempts = spec.maxValidationAttempts
      break
    case 'duo':
      body.api_hostname = spec.apiHostname
      body.integration_key = spec.integrationKey // WRITE-ONLY SECRET
      body.secret_key = spec.secretKey // WRITE-ONLY SECRET
      if (spec.usernameFormat) body.username_format = spec.usernameFormat
      if (spec.pushInfo) body.push_info = spec.pushInfo
      body.use_passcode = spec.usePasscode ?? false
      break
    case 'okta':
      body.org_name = spec.orgName
      body.api_token = spec.apiToken // WRITE-ONLY SECRET
      if (spec.baseUrl) body.base_url = spec.baseUrl
      if (spec.usernameFormat) body.username_format = spec.usernameFormat
      body.primary_email = spec.primaryEmail ?? false
      break
    case 'pingid':
      body.settings_file_base64 = spec.settingsFileBase64 // WRITE-ONLY SECRET
      if (spec.usernameFormat) body.username_format = spec.usernameFormat
      break
  }

  return body
}

/**
 * Capture a method's prior NON-SECRET fields for rollback of an update. The
 * write-only secrets are never returned by GET, so they are absent here — a
 * rollback re-asserts the non-secret config and leaves the secrets as the
 * rolled-back deploy set them (Vault keeps an omitted secret in place on
 * update). See rollback.ts, which documents this limitation.
 */
export function buildPriorBody(live: LiveMfaMethod): Record<string, unknown> {
  const prior: Record<string, unknown> = { method_name: live.method_name ?? '' }
  const copy = (key: string) => {
    if (live[key] !== undefined && live[key] !== null) prior[key] = live[key]
  }
  // totp
  copy('issuer')
  copy('period')
  copy('key_size')
  copy('algorithm')
  copy('digits')
  copy('skew')
  copy('max_validation_attempts')
  // duo / okta / shared (non-secret only)
  copy('api_hostname')
  copy('push_info')
  copy('use_passcode')
  copy('org_name')
  copy('base_url')
  copy('primary_email')
  copy('username_format')
  return prior
}
