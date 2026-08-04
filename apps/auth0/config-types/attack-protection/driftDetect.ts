import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, getJson } from '../../lib/auth0Api'
import { BREACHED_PASSWORD_DETECTION_PATH, BRUTE_FORCE_PROTECTION_PATH, SUSPICIOUS_IP_THROTTLING_PATH, declaredObjectField } from './_shared'

/** Compare only the declared keys of one sub-resource against its live object. */
function diffDeclaredKeys(prefix: string, declared: Record<string, unknown>, live: Record<string, unknown>, diffs: DriftDiff[]): void {
  for (const [key, value] of Object.entries(declared)) {
    const expected = JSON.stringify(value)
    const actual = JSON.stringify(live[key])
    if (expected !== actual) {
      diffs.push({ field: `${prefix}.${key}`, expected, actual, severity: 'warning' })
    }
  }
}

/**
 * Drift for Auth0 Attack Protection: for each declared (non-blank) field, GET
 * the live sub-resource and compare only the keys the operator declared — the
 * same "only compare declared keys" philosophy as connections' `options`
 * drift, so undeclared server-side defaults never raise false drift. A
 * sub-resource left blank is never read or compared. Best-effort — a read
 * error yields no drift, not a failure. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  const diffs: DriftDiff[] = []
  if (!item) return { hasDrift: false, diffs }

  const creds = resolveClientCredentials(credential)
  if (!creds) return { hasDrift: false, diffs }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    const breached = declaredObjectField(item.fields.breached_password_detection)
    if (breached.declared) {
      const live = await getJson<Record<string, unknown>>(`${base}/${BREACHED_PASSWORD_DETECTION_PATH}`, accessToken)
      diffDeclaredKeys('breached_password_detection', breached.value, live, diffs)
    }

    const bruteForce = declaredObjectField(item.fields.brute_force_protection)
    if (bruteForce.declared) {
      const live = await getJson<Record<string, unknown>>(`${base}/${BRUTE_FORCE_PROTECTION_PATH}`, accessToken)
      diffDeclaredKeys('brute_force_protection', bruteForce.value, live, diffs)
    }

    const suspiciousIp = declaredObjectField(item.fields.suspicious_ip_throttling)
    if (suspiciousIp.declared) {
      const live = await getJson<Record<string, unknown>>(`${base}/${SUSPICIOUS_IP_THROTTLING_PATH}`, accessToken)
      diffDeclaredKeys('suspicious_ip_throttling', suspiciousIp.value, live, diffs)
    }
  } catch {
    return { hasDrift: false, diffs: [] }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
