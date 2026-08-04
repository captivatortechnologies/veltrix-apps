import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, wazuhRequest } from '../../lib/wazuhApi'
import { normalizeXml } from './_shared'

/**
 * Drift for the manager-configuration singleton: compare the declared ossec.conf
 * against the live file (`GET /manager/configuration?raw=true`). Best-effort —
 * an unreachable manager or unreadable file raises no drift (surfaced at
 * deploy/health instead). Both sides are whitespace-normalized before compare.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (items.length === 0 || !credential) return { hasDrift: false, diffs }

  const declared = String(items[0].fields.ossecConfXml ?? '').trim()
  if (!declared) return { hasDrift: false, diffs }

  let baseUrl: string
  let auth: Record<string, string>
  try {
    const resolved = await getToken(component, connectivity, connectivityProvider, credential)
    baseUrl = resolved.baseUrl
    auth = bearerHeader(resolved.token)
  } catch {
    return { hasDrift: false, diffs }
  }

  let liveBody: string
  try {
    const res = await wazuhRequest(`${baseUrl}/manager/configuration?raw=true`, { headers: auth })
    if (!res.ok) return { hasDrift: false, diffs }
    liveBody = res.body
  } catch {
    return { hasDrift: false, diffs }
  }

  if (normalizeXml(declared) !== normalizeXml(liveBody)) {
    diffs.push({ field: 'ossec_config', expected: declared, actual: liveBody, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
