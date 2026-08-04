import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { readIllumioSettings, resolveIllumioCredential, buildIllumioBaseUrl, basicAuthHeader, sendJson, MISSING_CREDENTIAL_MESSAGE } from '../../lib/illumioApi'
import type { RollbackEntry } from './deploy'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Roll back a pairing profiles deploy. NO provision step — pairing profiles
 * take effect immediately (see deploy.ts), so restoring/deleting them is the
 * whole rollback.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  if (!base) return { success: false, message: 'No PCE host is configured — set the "PCE host" app setting.' }
  const cred = resolveIllumioCredential(ctx.credential)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.href) continue
    if (e.existed && e.prior) {
      try {
        await sendJson('PUT', `${base}${e.href}`, headers, e.prior, opts)
        restored++
      } catch (err) {
        failures.push(`restore ${e.name}: ${errorMessage(err)}`)
      }
    } else if (!e.existed) {
      try {
        await sendJson('DELETE', `${base}${e.href}`, headers, undefined, opts)
        deleted++
      } catch (err) {
        failures.push(`delete ${e.name}: ${errorMessage(err)}`)
      }
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back pairing profiles: ${deleted} deleted, ${restored} restored` }
}
