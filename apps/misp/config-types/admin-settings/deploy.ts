import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { normalizeYesNo, assertSettingSaved, type MispServerSetting, type ServerSettingsEditResponse } from './_shared'

/**
 * Deploy MISP server settings over the REST API (443):
 *   read (rollback): GET  /servers/getSetting/<name>          → prior value + metadata
 *   write:           POST /servers/serverSettingsEdit/<name>   { value, force }
 *
 * The setting NAME is the identity — settings always pre-exist in MISP (there is
 * no "create" concept for this store), so a name MISP doesn't recognize (404), a
 * `redacted` setting (secret material — 403 on read, never written here), or a
 * `cli_only` setting (rejects API writes) is skipped rather than attempted.
 * rollbackData records, per applied setting, whether it pre-existed and its
 * prior value so rollback can restore it.
 *
 * NOTE: verify /servers/getSetting/<name> + /servers/serverSettingsEdit/<name>
 * against a live MISP 2.4 instance.
 */
async function readSetting(base: string, headers: Record<string, string>, name: string): Promise<MispServerSetting | null> {
  try {
    return await getJson<MispServerSetting>(`${base}/servers/getSetting/${encodeURIComponent(name)}`, headers)
  } catch {
    return null // not found, redacted (403), or a transient error — treated as unavailable
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for admin settings deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const settings: Array<{ name: string; hadPrior: boolean; priorValue: unknown }> = []
  const applied: string[] = []
  const skipped: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const value = String(item.fields.value ?? '').trim()
      const force = normalizeYesNo(item.fields.force)

      const current = await readSetting(base, headers, name)
      if (!current) {
        skipped.push(`${name} (not found or redacted)`)
        continue
      }
      if (current.cli_only) {
        skipped.push(`${name} (CLI-only, cannot be set via the API)`)
        continue
      }

      const result = await sendJson<ServerSettingsEditResponse>('POST', `${base}/servers/serverSettingsEdit/${encodeURIComponent(name)}`, headers, { value, force })
      assertSettingSaved(name, result)

      settings.push({ name, hadPrior: true, priorValue: current.value })
      applied.push(name)
    }

    const skipNote = skipped.length ? ` (skipped ${skipped.length}: ${skipped.join(', ')})` : ''
    return {
      success: true,
      message: `Applied ${applied.length} setting(s): ${applied.join(', ') || '(none)'}${skipNote}`,
      artifacts: { applied, skipped },
      rollbackData: { settings },
    }
  } catch (error) {
    return {
      success: false,
      message: `Admin settings deploy failed after ${applied.length} setting(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied, skipped },
      rollbackData: { settings },
    }
  }
}
