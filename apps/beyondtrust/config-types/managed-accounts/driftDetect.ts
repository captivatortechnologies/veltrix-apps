import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, withSession } from '../../lib/beyondtrustApi'
import {
  findManagedAccount,
  findManagedSystemByName,
  listFrom,
  projectFromFields,
  projectFromLive,
  str,
  type ManagedAccount,
  type ManagedSystemRef,
} from './_shared'

/**
 * Drift for managed accounts: compare what we declare against the live account
 * in Password Safe, scoped to the resolved managed system. A declared account
 * that is MISSING (or whose parent system is missing) is a warning; a present
 * account whose description / password rule / release durations / check-
 * password flag differ is ALSO a warning — unlike the create-if-absent config
 * types, PUT /ManagedAccounts/{id} exists, so this drift is correctable by a
 * redeploy. Best-effort and read-only: GET /ManagedSystems and
 * GET /ManagedSystems/{id}/ManagedAccounts inside a PS-Auth session. Verify
 * against a live BeyondTrust instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)

  let systems: ManagedSystemRef[]
  try {
    systems = await withSession(base, credential, async (cookie) =>
      listFrom<ManagedSystemRef>(await getJson<unknown>(base, '/ManagedSystems', cookie)),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read systems, no drift asserted
  }

  // Cache each resolved system's live account list — several items commonly share one system.
  const accountsBySystem = new Map<string, ManagedAccount[]>()

  for (const item of items) {
    const systemName = str(item.fields.systemName)
    const accountName = str(item.fields.accountName)
    const domainName = str(item.fields.domainName)
    if (!systemName || !accountName) continue

    const label = domainName ? `${systemName}/${domainName}\\${accountName}` : `${systemName}/${accountName}`
    const system = findManagedSystemByName(systems, systemName)
    if (!system?.ManagedSystemID) {
      diffs.push({ field: label, expected: 'present', actual: 'managed system missing', severity: 'warning' })
      continue
    }

    const systemKey = String(system.ManagedSystemID)
    let live = accountsBySystem.get(systemKey)
    if (!live) {
      try {
        live = await withSession(base, credential, async (cookie) =>
          listFrom<ManagedAccount>(
            await getJson<unknown>(base, `/ManagedSystems/${encodeURIComponent(systemKey)}/ManagedAccounts`, cookie),
          ),
        )
      } catch {
        continue // best-effort: can't read this system's accounts, don't assert drift for it
      }
      accountsBySystem.set(systemKey, live)
    }

    const match = findManagedAccount(live, accountName, domainName)
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const expected = projectFromFields(item.fields)
    const actual = projectFromLive(match)

    if (expected.description && expected.description !== actual.description) {
      diffs.push({ field: `${label}.description`, expected: expected.description, actual: actual.description, severity: 'warning' })
    }
    if (expected.passwordRuleId !== null && expected.passwordRuleId !== actual.passwordRuleId) {
      diffs.push({ field: `${label}.passwordRuleId`, expected: String(expected.passwordRuleId), actual: String(actual.passwordRuleId ?? ''), severity: 'warning' })
    }
    if (expected.releaseDuration !== null && expected.releaseDuration !== actual.releaseDuration) {
      diffs.push({ field: `${label}.releaseDuration`, expected: String(expected.releaseDuration), actual: String(actual.releaseDuration ?? ''), severity: 'warning' })
    }
    if (expected.maxReleaseDuration !== null && expected.maxReleaseDuration !== actual.maxReleaseDuration) {
      diffs.push({ field: `${label}.maxReleaseDuration`, expected: String(expected.maxReleaseDuration), actual: String(actual.maxReleaseDuration ?? ''), severity: 'warning' })
    }
    if (expected.isaReleaseDuration !== null && expected.isaReleaseDuration !== actual.isaReleaseDuration) {
      diffs.push({ field: `${label}.isaReleaseDuration`, expected: String(expected.isaReleaseDuration), actual: String(actual.isaReleaseDuration ?? ''), severity: 'warning' })
    }
    if (expected.checkPasswordFlag !== actual.checkPasswordFlag) {
      diffs.push({ field: `${label}.checkPasswordFlag`, expected: String(expected.checkPasswordFlag), actual: String(actual.checkPasswordFlag), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
