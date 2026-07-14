import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  acsUpload,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  sleep,
  type AcsRequestOptions,
  type SplunkCloudExperience,
} from '../../lib/acs'
import { buildAppPackage, MAX_PACKAGE_BYTES, type BuiltPackage } from '../../lib/splunkPackage'
import { buildMultipartBody } from '../../lib/multipart'
import {
  appInspectLogin,
  DEFAULT_APPINSPECT_OPTIONS,
  MISSING_APPINSPECT_CREDENTIALS_MESSAGE,
  resolveAppInspectCredentials,
  vetPackage,
  type AppInspectOptions,
} from '../../lib/appInspect'
import { extractCloudAppSpecs } from './validate'

/**
 * Deploy Splunk Cloud PRIVATE apps / add-ons.
 *
 * Splunk Cloud does not allow arbitrary REST config writes. The only supported
 * route for a private app is, in this exact order:
 *
 *   1. BUILD    the .spl from the authored files            (lib/splunkPackage)
 *   2. VET      it with AppInspect                          (lib/appInspect)
 *   3. GATE     failure == 0 && error == 0 && manual_check == 0
 *   4. INSTALL  through ACS, then poll to a terminal state
 *
 * TWO tokens are involved and they are not interchangeable:
 *
 *   stack JWT       credential.apiToken   — Authorization: Bearer  (ACS)
 *   AppInspect JWT  credential.username/password -> api.splunk.com — proves the
 *                   package was vetted; ACS refuses the install without it
 *
 * The install request differs by experience:
 *
 *   Victoria  POST {acs}/{stack}/adminconfig/v2/apps/victoria
 *             Authorization: Bearer <stack_jwt>
 *             X-Splunk-Authorization: <appinspect_jwt>
 *             ACS-Legal-Ack: Y
 *             Content-Type: application/octet-stream
 *             body: the RAW .tar.gz bytes
 *
 *   Classic   POST {acs}/{stack}/adminconfig/v2/apps
 *             Authorization: Bearer <stack_jwt>
 *             ACS-Legal-Ack: Y
 *             Content-Type: multipart/form-data
 *             body: token=<appinspect_jwt> + package=@<file>
 *
 * `ACS-Legal-Ack: Y` acknowledges the unsupported-app disclaimer and is
 * REQUIRED — ACS rejects an install without it.
 *
 * Install is ASYNCHRONOUS: a `"status": "uploaded"` response means the app is
 * still installing and GET .../apps/victoria/{app} may 404 briefly while it is
 * in flight. `"installed"` is the terminal state, so the handler polls for it
 * rather than reporting success on the upload.
 */

// --- ACS app endpoints -------------------------------------------------------

/** Victoria namespaces the apps collection; Classic does not. */
export function appsBasePath(experience: SplunkCloudExperience): string {
  return experience === 'victoria' ? '/apps/victoria' : '/apps'
}

export function appPath(experience: SplunkCloudExperience, appId: string): string {
  return `${appsBasePath(experience)}/${encodeURIComponent(appId)}`
}

/** Shape of an app returned by GET .../apps/victoria/{app}. */
export interface LiveApp {
  appID?: string
  name?: string
  label?: string
  version?: string
  /** "uploaded" while installing; "installed" is terminal. */
  status?: string
}

export interface AppRollbackEntry {
  appId: string
  /** Did the app exist on the stack BEFORE this deploy? */
  existed: boolean
  /** Version that was installed before this deploy (upgrade case only). */
  previousVersion?: string
  previousLabel?: string
  /** Version this deploy installed. */
  installedVersion: string
  experience: SplunkCloudExperience
}

const TERMINAL_INSTALL_STATUS = 'installed'

// --- Handler -----------------------------------------------------------------

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message:
        'No ACS token available — store the Splunk Cloud JWT (sc_admin) in the credential "API token" field',
    }
  }

  // AppInspect is a SEPARATE service with its own credentials. Without them the
  // package cannot be vetted, and an unvetted package cannot be installed on
  // Cloud by any route — so fail loudly rather than skip vetting.
  const appInspectCredentials = resolveAppInspectCredentials(ctx.credential)
  if (!appInspectCredentials) {
    return { success: false, message: MISSING_APPINSPECT_CREDENTIALS_MESSAGE }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }
  const experience = settings.experience
  const inspect = readAppInspectOptions(ctx.settings)

  const specs = extractCloudAppSpecs(ctx.canvas).filter((s) => s.appId)
  const rollbackState: AppRollbackEntry[] = []
  const deployed: string[] = []
  const pending: string[] = []
  const packages: Record<string, unknown>[] = []
  const vetting: Record<string, unknown>[] = []

  try {
    // One login for the whole deploy — the same JWT vets every package and
    // travels to ACS with every install.
    const appInspectToken = await appInspectLogin(appInspectCredentials, inspect)

    for (const spec of specs) {
      // 1. Build ------------------------------------------------------------
      const pkg = buildAppPackage(spec.spec)
      if (pkg.sizeBytes > MAX_PACKAGE_BYTES) {
        throw new Error(
          `App "${spec.appId}" packages to ${(pkg.sizeBytes / 1024 / 1024).toFixed(1)} MB — ` +
            `Splunk Cloud rejects packages over ${MAX_PACKAGE_BYTES / 1024 / 1024} MB`,
        )
      }
      packages.push({
        appId: spec.appId,
        fileName: pkg.fileName,
        sha256: pkg.sha256,
        sizeBytes: pkg.sizeBytes,
        files: pkg.entries.filter((e) => e.type === 'file').map((e) => e.path),
      })

      // 2. Capture prior state ----------------------------------------------
      const current = await acsRequest(acs, 'GET', appPath(experience, spec.appId))
      const existing = current.status === 200 ? parseJson<LiveApp>(current.body) ?? {} : null
      if (current.status !== 200 && current.status !== 404) {
        throw new Error(`Failed to read app "${spec.appId}": ${acsErrorMessage(current)}`)
      }

      rollbackState.push({
        appId: spec.appId,
        existed: existing !== null,
        previousVersion: existing?.version,
        previousLabel: existing?.label,
        installedVersion: spec.version,
        experience,
      })

      // 3. Vet + gate --------------------------------------------------------
      const result = await vetPackage(appInspectToken, pkg, experience, inspect)
      vetting.push({
        appId: spec.appId,
        requestId: result.requestId,
        status: result.status,
        summary: result.summary,
        blockingChecks: result.blocking,
      })

      if (!result.allowed) {
        throw new Error(
          `App "${spec.appId}" was not installed — ${result.reason} ` +
            `(AppInspect request ${result.requestId})`,
        )
      }

      // 4. Install + poll to terminal ---------------------------------------
      const install = await installApp(acs, experience, appInspectToken, pkg)
      if (install.status !== 200 && install.status !== 201 && install.status !== 202) {
        throw new Error(`Failed to install app "${spec.appId}": ${acsErrorMessage(install)}`)
      }

      const installed = parseJson<LiveApp>(install.body)
      if (installed?.status !== TERMINAL_INSTALL_STATUS) {
        // "uploaded" (or no status at all) means the install is still running.
        const settled = await pollUntilInstalled(acs, experience, spec.appId)
        if (settled === null) pending.push(spec.appId)
        else if (settled.status !== TERMINAL_INSTALL_STATUS) {
          throw new Error(
            `App "${spec.appId}" did not reach the "installed" state (ACS reports "${settled.status ?? 'unknown'}")`,
          )
        }
      }

      deployed.push(spec.appId)
    }

    const pendingNote =
      pending.length > 0 ? ` (${pending.length} still installing: ${pending.join(', ')})` : ''
    return {
      success: true,
      message:
        `Vetted and installed ${deployed.length} private app(s) on stack "${stack}" (${experience}): ` +
        `${deployed.join(', ')}${pendingNote}`,
      artifacts: {
        stack,
        experience,
        deployedApps: deployed,
        pendingApps: pending,
        packages,
        appInspect: vetting,
      },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `App deployment to stack "${stack}" failed after ${deployed.length} of ${specs.length} app(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: {
        stack,
        experience,
        deployedApps: deployed,
        packages,
        appInspect: vetting,
        failedAt: specs[deployed.length]?.appId,
      },
      // Partial rollback data lets the platform revert what was already installed.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Install -----------------------------------------------------------------

/**
 * POST the vetted package to ACS.
 *
 * Victoria takes the RAW .tar.gz bytes and carries the AppInspect token in the
 * X-Splunk-Authorization header. Classic takes a multipart body whose `token`
 * field IS the AppInspect token. Both require `ACS-Legal-Ack: Y`.
 */
export async function installApp(
  acs: AcsRequestOptions,
  experience: SplunkCloudExperience,
  appInspectToken: string,
  pkg: BuiltPackage,
) {
  if (experience === 'victoria') {
    return acsUpload(acs, appsBasePath(experience), {
      body: pkg.bytes,
      contentType: 'application/octet-stream',
      headers: {
        'X-Splunk-Authorization': appInspectToken,
        'ACS-Legal-Ack': 'Y',
      },
    })
  }

  const multipart = buildMultipartBody([
    { name: 'token', value: appInspectToken },
    {
      name: 'package',
      fileName: pkg.fileName,
      contentType: 'application/octet-stream',
      bytes: pkg.bytes,
    },
  ])

  return acsUpload(acs, appsBasePath(experience), {
    body: multipart.body,
    contentType: multipart.contentType,
    headers: { 'ACS-Legal-Ack': 'Y' },
  })
}

/**
 * Poll the app until it reports the terminal "installed" status.
 *
 * A 404 is EXPECTED while the install is in flight, so it is treated as "keep
 * waiting" rather than as a missing app. Returns the live app once it settles,
 * or null if it is still installing when the attempts run out (the deploy then
 * reports it as pending rather than failing a install that is merely slow).
 */
export async function pollUntilInstalled(
  acs: AcsRequestOptions,
  experience: SplunkCloudExperience,
  appId: string,
  { attempts = 12, intervalMs = 5_000 }: { attempts?: number; intervalMs?: number } = {},
): Promise<LiveApp | null> {
  const path = appPath(experience, appId)

  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await acsRequest(acs, 'GET', path)

    if (res.status === 200) {
      const live = parseJson<LiveApp>(res.body) ?? {}
      // Anything that is not still uploading is settled — "installed" passes the
      // caller's check, anything else surfaces as a failure with ACS' own wording.
      if (live.status !== 'uploaded' && live.status !== 'installing') return live
    } else if (res.status !== 404 && res.status !== 202) {
      throw new Error(`Failed to read app "${appId}" while installing: ${acsErrorMessage(res)}`)
    }

    await sleep(intervalMs)
  }

  return null
}

// --- Settings ----------------------------------------------------------------

/**
 * AppInspect vetting is far slower than an ACS call (a package with bin/ scripts
 * routinely takes minutes), so it gets its own budget.
 */
export function readAppInspectOptions(settings: Record<string, unknown>): AppInspectOptions {
  const raw = settings.appinspect_max_wait_seconds
  const seconds =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? raw
      : DEFAULT_APPINSPECT_OPTIONS.maxWaitMs / 1000

  return {
    timeoutMs: DEFAULT_APPINSPECT_OPTIONS.timeoutMs,
    maxWaitMs: seconds * 1000,
  }
}
