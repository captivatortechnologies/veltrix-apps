import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  REST_TOKEN_MISSING,
  buildAuthHeader,
  buildRestUrl,
  deleteEntity,
  postForm,
  readRestSettings,
  resolveRestToken,
  resolveStackHost,
} from '../../lib/splunkRest'
import { SAML_BASE_PATH, buildRestorePayload, type SsoRollbackState } from './deploy'

/**
 * Roll back the SAML SSO provider using the state captured during deploy:
 *   - if a provider existed before, POST its captured prior non-secret values
 *     back to /services/authentication/providers/SAML/<name>
 *   - if none existed, DELETE the provider this deployment created (restore
 *     "no SAML provider")
 *
 * Runs against the same stack REST API on port 8089 as deploy — the same two
 * prerequisites apply, and failures name them.
 *
 * Caveat: the IdP certificate is write-only and is never read back, so a restore
 * re-applies only the non-secret fields; if the prior provider relied on a
 * certificate it must be re-uploaded in Splunk Web. This is surfaced in the
 * rollback message.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveRestToken(ctx.credential)
  if (!token) {
    return { success: false, message: `Rollback cannot reach the stack. ${REST_TOKEN_MISSING}` }
  }

  const previousState = (ctx.rollbackData as { previousState?: SsoRollbackState })?.previousState
  if (!previousState || !previousState.providerName) {
    return { success: false, message: 'No previous state available for SAML SSO rollback' }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const stack = resolveStackHost(ctx.component.hostname)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)
  const providerPath = `${SAML_BASE_PATH}/${encodeURIComponent(previousState.providerName)}`

  try {
    if (previousState.existed) {
      const payload = buildRestorePayload(previousState.prior ?? {})
      if (Object.keys(payload).length > 0) {
        await postForm(baseUrl, auth, providerPath, payload, timeoutMs)
      }
      return {
        success: true,
        message: `Restored the previous SAML SSO provider "${previousState.providerName}" on stack "${stack}" — re-upload the IdP certificate in Splunk Web if the prior provider required one (secrets cannot be restored automatically)`,
      }
    }

    // No provider existed before — remove the one this deployment created.
    await deleteEntity(baseUrl, auth, providerPath, timeoutMs)
    return {
      success: true,
      message: `Removed the SAML SSO provider "${previousState.providerName}" on stack "${stack}" (restored to no SAML provider — the state before deployment)`,
    }
  } catch (error) {
    return {
      success: false,
      message: `SAML SSO rollback on stack "${stack}" failed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
