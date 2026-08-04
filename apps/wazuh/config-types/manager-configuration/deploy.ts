import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, wazuhRequest } from '../../lib/wazuhApi'

/**
 * Deploy the Wazuh manager-configuration SINGLETON over the REST API (55000):
 *   read (rollback): GET ${base}/manager/configuration?raw=true       (raw ossec.conf text; best-effort)
 *   apply:           PUT ${base}/manager/configuration                (raw ossec.conf body, application/octet-stream)
 *   validate:        GET ${base}/manager/configuration/validation     (best-effort — reports OK/ERROR per node)
 *   reload:          PUT ${base}/manager/restart                      (best-effort — most sections need a restart to take effect)
 *
 * Only the FIRST canvas item is applied (see validate.ts's SINGLETON_EXCESS
 * warning). `comment` is audit-only and is never sent to the manager. The PUT
 * content type (`application/octet-stream`) and the `raw=true` GET behavior
 * ("Format response in plain text") are per the verified v4.14.7 OpenAPI spec
 * for this specific endpoint — unlike this app's other XML config types, whose
 * exact GET serialization is a documented assumption (see their own module docs).
 *
 * rollbackData.previous records the prior raw file body (null if the pre-deploy
 * GET failed) so rollback can PUT it back.
 */

/** Read the live ossec.conf raw body (best-effort) for the rollback snapshot; null on any miss. */
async function readManagerConfiguration(base: string, headers: Record<string, string>): Promise<string | null> {
  try {
    const res = await wazuhRequest(`${base}/manager/configuration?raw=true`, { headers })
    if (!res.ok) return null
    return res.body
  } catch {
    return null
  }
}

/** Best-effort post-write config-validation check; never throws — the outcome is reported. */
async function checkValidation(base: string, headers: Record<string, string>): Promise<string> {
  try {
    const res = await wazuhRequest(`${base}/manager/configuration/validation`, { headers })
    if (!res.ok) return `not confirmed (HTTP ${res.status})`
    const parsed = JSON.parse(res.body || '{}') as { data?: { affected_items?: Array<{ status?: string }> } }
    const statuses = parsed.data?.affected_items?.map((i) => i.status ?? 'unknown') ?? []
    return statuses.length ? statuses.join(', ') : 'unknown'
  } catch (error) {
    return `failed (${error instanceof Error ? error.message : 'error'})`
  }
}

/** Best-effort manager restart to reload the new configuration; never throws — the outcome is reported. */
async function requestRestart(base: string, headers: Record<string, string>): Promise<string> {
  try {
    const res = await wazuhRequest(`${base}/manager/restart`, { method: 'PUT', headers })
    return res.ok ? `requested (HTTP ${res.status})` : `not confirmed (HTTP ${res.status})`
  } catch (error) {
    return `failed (${error instanceof Error ? error.message : 'error'})`
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (items.length === 0) {
    return { success: false, message: 'No Manager Configuration item to deploy' }
  }
  if (!credential) {
    return { success: false, message: 'Missing credential for manager-configuration deployment' }
  }

  const ossecConfXml = String(items[0].fields.ossecConfXml ?? '')
  let previous: string | null = null

  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    previous = await readManagerConfiguration(baseUrl, auth)

    const url = `${baseUrl}/manager/configuration`
    const res = await wazuhRequest(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...auth },
      body: ossecConfXml,
    })
    if (!res.ok) throw new Error(`PUT ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)

    const validation = await checkValidation(baseUrl, auth)
    const restart = await requestRestart(baseUrl, auth)

    return {
      success: true,
      message: `Applied manager configuration. Validation: ${validation}. Manager restart: ${restart}.`,
      artifacts: { validation },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Manager-configuration deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      rollbackData: { previous },
    }
  }
}
