import {
  acsErrorMessage,
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
} from '../lib/acs'
import type { OperationContext, OperationResult } from './types'

// =============================================================================
// Splunk Cloud — retry failed operation.
//
// Re-submits the stack's most recent failed ACS operation via
// `POST /adminconfig/v2/deployment/retry`. ACS supports retry for private app
// installation and HEC token management operations only. A `status` of "new"
// means the retry was accepted; retries run asynchronously.
// =============================================================================

export default async function retryFailed(ctx: OperationContext): Promise<OperationResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return { ok: false, message: 'No stack / endpoint is configured for the selected connection.' }
  }

  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      ok: false,
      message: 'No ACS token found. Store the stack JWT in the connection’s API token field.',
    }
  }

  const stack = resolveStackName(host)
  const { baseUrl, timeoutMs } = readAcsSettings(ctx.settings)

  try {
    const res = await acsRequest(
      { baseUrl, stack, token, timeoutMs: Math.min(timeoutMs, 15000) },
      'POST',
      '/deployment/retry',
    )

    if (res.ok || res.status === 200 || res.status === 202) {
      const body = parseJson<{ status?: string }>(res.body)
      const status = body?.status ? ` (status: ${body.status})` : ''
      return {
        ok: true,
        message: `Retry submitted for the latest failed operation on stack "${stack}"${status}. Retries run asynchronously and cover private-app installs and HEC token operations.`,
        details: [`Stack: ${stack}`, `ACS: ${baseUrl}`],
      }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `ACS rejected the token (HTTP ${res.status}). The stack JWT is invalid, expired, or lacks privilege.`,
        details: [`Stack: ${stack}`, `ACS says: ${acsErrorMessage(res)}`],
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `No retryable failed operation was found for stack "${stack}" (404).`,
        details: [`ACS says: ${acsErrorMessage(res)}`],
      }
    }
    return {
      ok: false,
      message: `Retry request returned HTTP ${res.status}. ${acsErrorMessage(res)}`,
      details: [`Stack: ${stack}`],
    }
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach ACS to retry on stack "${stack}": ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
      details: [`Stack: ${stack}`, `ACS: ${baseUrl}`],
    }
  }
}
