import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  readIllumioSettings,
  resolveIllumioCredential,
  buildIllumioBaseUrl,
  basicAuthHeader,
  sendJson,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/illumioApi'
import type { RollbackEntry } from './deploy'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Roll back a labels deploy using the rollbackData it recorded:
 *   existed=true  → restore the prior external_data_set/reference (PUT {href})
 *   existed=false → this deploy created it — remove it (DELETE {href})
 * `key` is immutable in the PCE, so an update never touches it.
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
    const identity = `${e.key} ${e.value}`

    if (e.existed) {
      try {
        await sendJson(
          'PUT',
          `${base}${e.href}`,
          headers,
          {
            value: e.value,
            external_data_set: e.priorExternalDataSet ?? '',
            external_data_reference: e.priorExternalDataReference ?? '',
          },
          opts,
        )
        restored++
      } catch (err) {
        failures.push(`restore ${identity}: ${errorMessage(err)}`)
      }
    } else {
      try {
        await sendJson('DELETE', `${base}${e.href}`, headers, undefined, opts)
        deleted++
      } catch (err) {
        failures.push(`delete ${identity}: ${errorMessage(err)}`)
      }
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back labels: ${deleted} deleted, ${restored} restored` }
}
