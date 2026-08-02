import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, withSession } from '../../lib/beyondtrustApi'
import { accountsFromList, findFunctionalAccount, str, toPlatformId } from './_shared'

/**
 * Drift for functional accounts: compare what we declare against the live account
 * in Password Safe. A declared account that is MISSING is a warning; a present
 * account whose display name / description / elevation command differ is info
 * (Password Safe has no update endpoint, so these can only be corrected by delete
 * + recreate). Best-effort and read-only: GET /FunctionalAccounts inside a PS-Auth
 * session. Verify against a live BeyondTrust instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)

  let live
  try {
    live = await withSession(base, credential, async (cookie) =>
      accountsFromList(await getJson<unknown>(base, '/FunctionalAccounts', cookie)),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read accounts, no drift asserted
  }

  for (const item of items) {
    const accountName = str(item.fields.accountName)
    const platformId = toPlatformId(item.fields.platformId)
    const domainName = str(item.fields.domainName)
    if (!accountName || platformId === null) continue

    const label = domainName ? `${domainName}\\${accountName}` : accountName
    const match = findFunctionalAccount(live, platformId, domainName, accountName)

    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const desiredDisplay = str(item.fields.displayName)
    if (desiredDisplay && str(match.DisplayName) !== desiredDisplay) {
      diffs.push({ field: `${label}.displayName`, expected: desiredDisplay, actual: match.DisplayName ?? '', severity: 'info' })
    }

    const desiredDescription = str(item.fields.description)
    if (desiredDescription && str(match.Description) !== desiredDescription) {
      diffs.push({ field: `${label}.description`, expected: desiredDescription, actual: match.Description ?? '', severity: 'info' })
    }

    const desiredElevation = str(item.fields.elevationCommand)
    if (desiredElevation && str(match.ElevationCommand) !== desiredElevation) {
      diffs.push({ field: `${label}.elevationCommand`, expected: desiredElevation, actual: match.ElevationCommand ?? '', severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
