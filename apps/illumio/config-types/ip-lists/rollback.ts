import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  readIllumioSettings,
  resolveIllumioCredential,
  buildIllumioBaseUrl,
  basicAuthHeader,
  sendJson,
  provisionChanges,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/illumioApi'
import type { RollbackEntry } from './deploy'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Roll back an IP lists deploy: restore prior bodies (PUT) / delete what this
 * deploy created (DELETE), then PROVISION those draft changes too — undoing a
 * draft write does not take effect until it is re-provisioned, exactly like
 * the original deploy.
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
  const changedHrefs: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.href) continue
    if (e.existed && e.prior) {
      try {
        await sendJson('PUT', `${base}${e.href}`, headers, e.prior, opts)
        restored++
        changedHrefs.push(e.href)
      } catch (err) {
        failures.push(`restore ${e.name}: ${errorMessage(err)}`)
      }
    } else if (!e.existed) {
      try {
        await sendJson('DELETE', `${base}${e.href}`, headers, undefined, opts)
        deleted++
        changedHrefs.push(e.href)
      } catch (err) {
        failures.push(`delete ${e.name}: ${errorMessage(err)}`)
      }
    }
  }

  let provisionNote = ''
  if (changedHrefs.length > 0) {
    try {
      await provisionChanges(base, settings, headers, `Veltrix: rollback IP lists (${changedHrefs.length} change(s))`, {
        ip_lists: changedHrefs.map((href) => ({ href })),
      })
      provisionNote = `; provisioned ${changedHrefs.length} change(s)`
    } catch (err) {
      failures.push(`provision failed: ${errorMessage(err)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back IP lists: ${deleted} deleted, ${restored} restored${provisionNote}` }
}
