import {
  acsUrl,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../lib/acs'
import type { OperationContext, OperationResult } from './types'

// =============================================================================
// Splunk Cloud — export app operation.
//
// Downloads an installed app as a .tar.gz via
// `GET /adminconfig/v2/apps/victoria/export/download/{app_id}`. Victoria
// Experience only; requires the export_apps capability. Optional scope flags
// (default / local / users / confs_only) limit which directories/confs export.
//
// The binary is returned base64-encoded in `data` so the client can trigger a
// browser download — capped so a huge package doesn't bloat the JSON response.
// =============================================================================

const MAX_EXPORT_BYTES = 25 * 1024 * 1024 // 25 MB

export default async function exportApp(ctx: OperationContext): Promise<OperationResult> {
  const appName = String(ctx.params.appName ?? ctx.params.app ?? '').trim()
  if (!appName) {
    return { ok: false, message: 'Provide the app name (params.appName) to export.' }
  }

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
  const acs: AcsRequestOptions = { baseUrl, stack, token, timeoutMs }

  // Optional scope flags — export only the requested directories/confs.
  const flags = ['default', 'local', 'users', 'confs_only'] as const
  const query = flags
    .filter((f) => ctx.params[f] === true || ctx.params[f] === 'true')
    .map((f) => `${f}=true`)
    .join('&')
  const path = `/apps/victoria/export/download/${encodeURIComponent(appName)}${query ? `?${query}` : ''}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 60000))
  try {
    const res = await fetch(acsUrl(acs, path), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' },
      signal: controller.signal,
    })

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `ACS rejected the token (HTTP ${res.status}). The stack JWT is invalid/expired or lacks the export_apps capability.`,
        details: [`Stack: ${stack}`],
      }
    }
    if (res.status === 404) {
      return { ok: false, message: `App "${appName}" was not found on stack "${stack}" (404).` }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false,
        message: `Export returned HTTP ${res.status}. ${text.slice(0, 200)}`,
        details: [`Stack: ${stack}`],
      }
    }

    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_EXPORT_BYTES) {
      return {
        ok: false,
        message: `Exported package for "${appName}" is ${(buf.length / 1048576).toFixed(1)} MB — above the ${MAX_EXPORT_BYTES / 1048576} MB in-app download limit. Download it directly from ACS instead.`,
        details: [`GET ${acsUrl(acs, path)}`],
      }
    }

    return {
      ok: true,
      message: `Exported "${appName}" from stack "${stack}" (${(buf.length / 1024).toFixed(1)} KB).`,
      details: [`Stack: ${stack}`, 'Victoria Experience; requires the export_apps capability'],
      data: {
        filename: `${appName}.tar.gz`,
        contentType: 'application/gzip',
        base64: buf.toString('base64'),
      },
    }
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach ACS to export "${appName}" from stack "${stack}": ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
      details: [`Stack: ${stack}`],
    }
  } finally {
    clearTimeout(timer)
  }
}
