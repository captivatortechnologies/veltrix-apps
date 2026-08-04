import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, getJson } from '../../lib/auth0Api'
import { readString, stringSetsEqual } from '../../lib/fields'
import {
  FACTOR_FIELD_TO_NAME,
  GUARDIAN_FACTORS_PATH,
  GUARDIAN_POLICIES_PATH,
  indexFactors,
  policyToArray,
  readFactorFields,
  type Auth0GuardianFactor,
} from './_shared'

/**
 * Drift for Auth0 MFA: compare the declared policy array vs the live
 * /guardian/policies array, and each of the 8 factors' enabled bool vs the
 * live /guardian/factors array. Best-effort — a read error yields no drift,
 * not a failure. Read-only.
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

    const livePolicyArray = await getJson<string[]>(`${base}/${GUARDIAN_POLICIES_PATH}`, accessToken)
    const desiredPolicyArray = policyToArray(readString(item.fields.policy) || 'never')
    const actualPolicyArray = Array.isArray(livePolicyArray) ? livePolicyArray : []
    if (!stringSetsEqual(desiredPolicyArray, actualPolicyArray)) {
      diffs.push({ field: 'policy', expected: desiredPolicyArray, actual: actualPolicyArray, severity: 'warning' })
    }

    const liveFactorsList = await getJson<Auth0GuardianFactor[]>(`${base}/${GUARDIAN_FACTORS_PATH}`, accessToken)
    const liveFactors = indexFactors(Array.isArray(liveFactorsList) ? liveFactorsList : [])
    const desiredFactors = readFactorFields(item.fields)
    for (const factorName of Object.values(FACTOR_FIELD_TO_NAME)) {
      const expected = desiredFactors[factorName]
      const actual = liveFactors[factorName] === true
      if (expected !== actual) {
        diffs.push({ field: `factors.${factorName}`, expected: String(expected), actual: String(actual), severity: 'warning' })
      }
    }
  } catch {
    return { hasDrift: false, diffs: [] }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
