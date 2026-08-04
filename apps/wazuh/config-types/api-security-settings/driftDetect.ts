import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, getJson } from '../../lib/wazuhApi'
import { specFromItem, toSecurityConfigBody, securityConfigEquals, type SecuritySettingsBody } from './_shared'

/**
 * Drift for the API-security-settings singleton: compare the declared
 * `{ auth_token_exp_timeout, rbac_mode }` against live. Best-effort — an
 * unreachable manager or unreadable config raises no drift (surfaced at
 * deploy/health instead).
 */
interface SecurityConfigEnvelope {
  data?: SecuritySettingsBody
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (items.length === 0 || !credential) return { hasDrift: false, diffs }

  let baseUrl: string
  let auth: Record<string, string>
  try {
    const resolved = await getToken(component, connectivity, connectivityProvider, credential)
    baseUrl = resolved.baseUrl
    auth = bearerHeader(resolved.token)
  } catch {
    return { hasDrift: false, diffs }
  }

  let live: SecuritySettingsBody
  try {
    const envelope = await getJson<SecurityConfigEnvelope>(`${baseUrl}/security/config`, auth)
    if (!envelope.data) return { hasDrift: false, diffs }
    live = envelope.data
  } catch {
    return { hasDrift: false, diffs }
  }

  const declared = toSecurityConfigBody(specFromItem(items[0]))
  if (!securityConfigEquals(declared, live)) {
    diffs.push({ field: 'security_config', expected: declared, actual: live, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
