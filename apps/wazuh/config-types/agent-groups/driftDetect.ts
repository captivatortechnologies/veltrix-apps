import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, wazuhRequest } from '../../lib/wazuhApi'
import { normalizeXml } from './_shared'

/**
 * Drift for agent groups: compare the shared agent.conf we declare against the
 * live group configuration on the manager. Best-effort — a group whose config
 * can't be read (missing / transient error) is skipped rather than raising false
 * drift. Items that declare no agent.conf are skipped (nothing to compare).
 *
 * NOTE (verify against a live Wazuh 4.x manager): the GET configuration body may
 * be raw XML or a JSON envelope; both sides are whitespace-normalized before the
 * comparison — refine once the exact GET serialization is confirmed.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  let baseUrl: string
  let auth: Record<string, string>
  try {
    const resolved = await getToken(component, connectivity, connectivityProvider, credential)
    baseUrl = resolved.baseUrl
    auth = bearerHeader(resolved.token)
  } catch {
    return { hasDrift: false, diffs } // can't authenticate — surface at deploy/health, not as drift
  }

  for (const item of items) {
    const groupName = String(item.fields.groupName ?? '').trim()
    const declared = String(item.fields.agentConf ?? '').trim()
    if (!groupName || !declared) continue

    let liveBody: string
    try {
      const res = await wazuhRequest(`${baseUrl}/groups/${encodeURIComponent(groupName)}/configuration`, { headers: auth })
      if (!res.ok) continue // best-effort: skip a group we can't read
      liveBody = res.body
    } catch {
      continue
    }

    if (normalizeXml(declared) !== normalizeXml(liveBody)) {
      diffs.push({ field: `${groupName}.agent.conf`, expected: declared, actual: liveBody, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
