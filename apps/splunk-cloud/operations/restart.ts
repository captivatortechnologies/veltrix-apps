import {
  acsErrorMessage,
  acsRequest,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
} from '../lib/acs'
import type { OperationContext, OperationResult } from './types'

// =============================================================================
// Splunk Cloud — restart operation.
//
// Initiates a restart via ACS `POST /adminconfig/v2/restart-now`: a single
// search head restarts, or a search head cluster performs a rolling restart. A
// 202 means the restart is in progress (it takes several minutes). Requires the
// stack JWT with sufficient privilege; ACS/restart is unavailable on
// single-instance trials.
// =============================================================================

export default async function restart(ctx: OperationContext): Promise<OperationResult> {
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
      '/restart-now',
    )

    if (res.status === 202 || res.ok) {
      return {
        ok: true,
        message: `Restart initiated for stack "${stack}" (HTTP ${res.status}). A rolling restart can take several minutes; search may be briefly unavailable.`,
        details: [`Stack: ${stack}`, `ACS: ${baseUrl}`],
      }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `ACS rejected the token (HTTP ${res.status}). The stack JWT is invalid, expired, or lacks restart privilege.`,
        details: [`Stack: ${stack}`, `ACS says: ${acsErrorMessage(res)}`],
      }
    }
    return {
      ok: false,
      message: `Restart request returned HTTP ${res.status}. ${acsErrorMessage(res)}`,
      details: [`Stack: ${stack}`],
    }
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach ACS to restart stack "${stack}": ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
      details: [`Stack: ${stack}`, `ACS: ${baseUrl}`],
    }
  }
}
