import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { cyberArkErrorMessage, parseCollectionArray, buildCyberArkClient, type CyberArkClient } from '../../lib/cyberark'
import {
  appKey,
  authMethodSignature,
  extractApplicationSpecs,
  parseAuthMethods,
  type ApplicationSpec,
  type AuthMethodSpec,
  type LiveApplication,
  type LiveAuthMethod,
} from './validate'

/**
 * Rollback state for one application. `priorAuthMethods` is the FULL live
 * authentication-method list captured before reconciliation (both for a new
 * and an existing application), so rollback can restore it symmetrically by
 * re-running the same reconcile logic in reverse (see rollback.ts).
 */
export interface ApplicationRollbackEntry {
  key: string
  label: string
  existed: boolean
  priorAuthMethods: LiveAuthMethod[]
}

/**
 * Deploy CyberArk applications (AAM/CCP identities) via the classic PVWA Web
 * Services (`/PasswordVault/WebServices/PIMServices.svc/Applications`).
 *
 * Identity is the AppID: list Applications, match on AppID, POST create when
 * missing. ⚠ NO UPDATE ENDPOINT is exposed for an application's own fields
 * (AppID/Description/Location/access window/business owner) in the verified
 * endpoint set this app was built against — an existing application's
 * top-level fields are therefore left untouched (see README "Coverage"); only
 * its authentication-methods child collection is reconciled (add/remove),
 * which DOES have dedicated endpoints, for both a new and an existing app.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, pvwaUrl } = built

  const specs = extractApplicationSpecs(ctx.canvas).filter((s) => s.appId)
  const rollbackState: ApplicationRollbackEntry[] = []
  const deployed: string[] = []
  const notes: string[] = []

  try {
    const byKey = await mapApplications(client)

    for (const spec of specs) {
      const label = spec.appId
      const key = appKey(spec)
      const live = byKey.get(key)
      const methods = parseAuthMethods(spec.authMethodsJson)
      const desiredMethods = methods.value ?? []

      if (!live) {
        const res = await client.requestLegacy('POST', '/Applications/', { body: { application: buildCreateBody(spec) } })
        if (!res.ok) throw new Error(`Failed to create application "${label}": ${cyberArkErrorMessage(res)}`)
      } else {
        notes.push(`Application "${label}" already exists — its top-level fields are not updated (no verified update endpoint); only authentication methods are reconciled`)
      }

      const priorAuthMethods = await listAuthMethods(client, spec.appId)
      await reconcileAuthMethods(client, spec.appId, desiredMethods, priorAuthMethods)
      rollbackState.push({ key, label, existed: !!live, priorAuthMethods })
      deployed.push(label)
    }

    await client.logoff()
    return {
      success: true,
      message: `Deployed ${deployed.length} application(s) to ${pvwaUrl}: ${deployed.join(', ')}${notes.length ? ` (${notes.length} note(s))` : ''}`,
      artifacts: { pvwaUrl, deployedApplications: deployed, notes },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Application deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { pvwaUrl, deployedApplications: deployed, notes },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** List all applications; throws on a non-OK response. */
export async function listApplications(client: CyberArkClient): Promise<LiveApplication[]> {
  const res = await client.requestLegacy('GET', '/Applications/')
  if (!res.ok) {
    throw new Error(`Failed to list applications: ${cyberArkErrorMessage(res)}`)
  }
  return parseCollectionArray<LiveApplication>(res.body, ['application', 'Application', 'Applications'])
}

/** Index live applications by their natural key (AppID, lower-cased). */
export async function mapApplications(client: CyberArkClient): Promise<Map<string, LiveApplication>> {
  const apps = await listApplications(client)
  return new Map(apps.filter((a) => typeof a.AppID === 'string' && a.AppID).map((a) => [appKey({ appId: a.AppID as string }), a]))
}

/** List an application's authentication methods; [] (not throw) on a non-OK response — a brand-new app may 404. */
export async function listAuthMethods(client: CyberArkClient, appId: string): Promise<LiveAuthMethod[]> {
  const res = await client.requestLegacy('GET', `/Applications/${encodeURIComponent(appId)}/Authentications/`)
  if (!res.ok) return []
  return parseCollectionArray<LiveAuthMethod>(res.body, ['authentication', 'Authentication', 'Authentications'])
}

/**
 * Reconcile an application's authentication methods to `desired`, diffing
 * against `live` by their semantic signature (authType + value/cert
 * attributes — CyberArk assigns no meaningful natural key of its own).
 * Adds every desired method missing from live, removes every live method not
 * in desired. Shared by deploy (desired = spec) and rollback (desired = the
 * captured prior list) so both directions use identical logic.
 */
export async function reconcileAuthMethods(
  client: CyberArkClient,
  appId: string,
  desired: AuthMethodSpec[],
  live: LiveAuthMethod[],
): Promise<void> {
  const liveSignatures = new Set(live.map((m) => authMethodSignature({ authType: m.AuthType ?? '', authValue: m.AuthValue, issuer: m.Issuer, subject: m.Subject, subjectAlternativeName: m.SubjectAlternativeName })))
  const desiredSignatures = new Set(desired.map((m) => authMethodSignature(m)))

  for (const method of desired) {
    if (liveSignatures.has(authMethodSignature(method))) continue
    const res = await client.requestLegacy('POST', `/Applications/${encodeURIComponent(appId)}/Authentications`, {
      body: { authentication: buildAuthMethodBody(method) },
    })
    if (!res.ok) {
      throw new Error(`Failed to add ${method.authType} authentication to application "${appId}": ${cyberArkErrorMessage(res)}`)
    }
  }

  for (const entry of live) {
    const sig = authMethodSignature({ authType: entry.AuthType ?? '', authValue: entry.AuthValue, issuer: entry.Issuer, subject: entry.Subject, subjectAlternativeName: entry.SubjectAlternativeName })
    if (desiredSignatures.has(sig)) continue
    // ⚠ The exact id field GET returns is not independently confirmed — every
    // plausible casing is checked defensively (see LiveAuthMethod).
    const authId = entry.authID ?? entry.AuthID ?? entry.id ?? entry.WebServiceID ?? entry.WebServiceId
    if (authId === undefined) continue // nothing addressable to delete — leave it in place rather than guess
    const res = await client.requestLegacy('DELETE', `/Applications/${encodeURIComponent(appId)}/Authentications/${encodeURIComponent(String(authId))}`)
    if (res.status !== 404 && !res.ok) {
      throw new Error(`Failed to remove ${entry.AuthType ?? 'unknown'} authentication from application "${appId}": ${cyberArkErrorMessage(res)}`)
    }
  }
}

/** Build the POST .../Applications/ body's `application` object. */
function buildCreateBody(spec: ApplicationSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    AppID: spec.appId,
    Description: spec.description,
    Location: spec.location,
    Disabled: spec.disabled,
  }
  if (spec.accessPermittedFromHour !== null) body.AccessPermittedFrom = spec.accessPermittedFromHour
  if (spec.accessPermittedToHour !== null) body.AccessPermittedTo = spec.accessPermittedToHour
  if (spec.expirationDate) body.ExpirationDate = spec.expirationDate
  if (spec.businessOwnerFirstName) body.BusinessOwnerFName = spec.businessOwnerFirstName
  if (spec.businessOwnerLastName) body.BusinessOwnerLName = spec.businessOwnerLastName
  if (spec.businessOwnerEmail) body.BusinessOwnerEmail = spec.businessOwnerEmail
  if (spec.businessOwnerPhone) body.BusinessOwnerPhone = spec.businessOwnerPhone
  return body
}

/** Build the POST .../Authentications body's `authentication` object for one method. */
function buildAuthMethodBody(method: AuthMethodSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { AuthType: method.authType }
  if (method.authValue) body.AuthValue = method.authValue
  if (method.isFolder !== undefined) body.IsFolder = method.isFolder
  if (method.allowInternalScripts !== undefined) body.AllowInternalScripts = method.allowInternalScripts
  if (method.comment) body.Comment = method.comment
  if (method.issuer?.length) body.Issuer = method.issuer
  if (method.subject?.length) body.Subject = method.subject
  if (method.subjectAlternativeName?.length) body.SubjectAlternativeName = method.subjectAlternativeName
  return body
}
