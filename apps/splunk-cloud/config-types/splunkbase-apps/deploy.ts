import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  acsUrl,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  sleep,
  type AcsRequestOptions,
  type SplunkCloudExperience,
} from '../../lib/acs'
import {
  MISSING_SPLUNKBASE_CREDENTIALS_MESSAGE,
  resolveSplunkbaseCredentials,
  splunkbaseLogin,
} from '../../lib/splunkbase'
import { extractSplunkbaseAppSpecs, type SplunkbaseAppSpec } from './validate'

/**
 * Deploy Splunkbase apps to a Splunk Cloud stack via ACS.
 *
 * Unlike this app's "Splunk Apps" (private app) type, there is no build or
 * AppInspect step — a Splunkbase app is already vetted by Splunk before
 * publication. The only work here is: authenticate to Splunkbase, then
 * install/upgrade through the SAME `apps`/`apps/victoria` collection ACS uses
 * for private apps, switched to Splunkbase mode with `?splunkbase=true`:
 *
 *   install  POST {acs}/{stack}/adminconfig/v2/apps/victoria?splunkbase=true
 *            Authorization: Bearer <stack_jwt>
 *            X-Splunkbase-Authorization: <splunkbase_session_id>
 *            ACS-Licensing-Ack: <license URL>
 *            Content-Type: application/x-www-form-urlencoded
 *            body: splunkbaseID=<id>&version=<version>            (Classic: /apps)
 *
 *   upgrade  PATCH {acs}/{stack}/adminconfig/v2/apps/victoria/{appName}
 *            (same headers/body as install)
 *
 *   describe GET {acs}/{stack}/adminconfig/v2/apps/victoria/{appName}
 *   uninstall DELETE {acs}/{stack}/adminconfig/v2/apps/victoria/{appName}
 *
 * TWO tokens are involved and they are not interchangeable — the stack JWT
 * authenticates the caller, the Splunkbase session id proves the account may
 * install the app. Both are required; deploy fails loudly rather than
 * skipping either, exactly like the private-app type fails without an
 * AppInspect login.
 *
 * Install/upgrade is ASYNCHRONOUS, so the handler polls the describe endpoint
 * to the terminal "installed" state, same as the private-app type.
 */

const TERMINAL_INSTALL_STATUS = 'installed'

export interface SplunkbaseRollbackEntry {
  appName: string
  existed: boolean
  previousVersion?: string
  previousLabel?: string
  installedVersion: string
  experience: SplunkCloudExperience
}

interface LiveSplunkbaseApp {
  appID?: string
  name?: string
  label?: string
  version?: string
  status?: string
}

function appsBasePath(experience: SplunkCloudExperience): string {
  return experience === 'victoria' ? '/apps/victoria' : '/apps'
}

function splunkbaseCollectionPath(experience: SplunkCloudExperience): string {
  return `${appsBasePath(experience)}?splunkbase=true`
}

function appPath(experience: SplunkCloudExperience, appName: string): string {
  return `${appsBasePath(experience)}/${encodeURIComponent(appName)}`
}

function buildInstallBody(spec: SplunkbaseAppSpec): string {
  const params = new URLSearchParams()
  params.set('splunkbaseID', spec.splunkbaseId)
  // Docs show the Victoria upgrade example omitting splunkbaseID and the
  // Classic upgrade example omitting version — send both whenever declared so
  // neither experience is short a parameter it turns out to need.
  if (spec.version) params.set('version', spec.version)
  return params.toString()
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message:
        'No ACS token available — store the Splunk Cloud JWT (sc_admin) in the credential "API token" field',
    }
  }

  const splunkbaseCredentials = resolveSplunkbaseCredentials(ctx.credential)
  if (!splunkbaseCredentials) {
    return { success: false, message: MISSING_SPLUNKBASE_CREDENTIALS_MESSAGE }
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

  const specs = extractSplunkbaseAppSpecs(ctx.canvas).filter((s) => s.appName && s.splunkbaseId)
  const rollbackState: SplunkbaseRollbackEntry[] = []
  const deployed: string[] = []
  const pending: string[] = []

  try {
    // One Splunkbase login for the whole deploy.
    const sessionId = await splunkbaseLogin(splunkbaseCredentials, { timeoutMs: settings.timeoutMs })
    const headers = {
      'X-Splunkbase-Authorization': sessionId,
    }

    for (const spec of specs) {
      const current = await acsRequest(acs, 'GET', appPath(experience, spec.appName))
      const existing = current.status === 200 ? (parseJson<LiveSplunkbaseApp>(current.body) ?? {}) : null
      if (current.status !== 200 && current.status !== 404) {
        throw new Error(`Failed to read app "${spec.appName}": ${acsErrorMessage(current)}`)
      }

      rollbackState.push({
        appName: spec.appName,
        existed: existing !== null,
        previousVersion: existing?.version,
        previousLabel: existing?.label,
        installedVersion: spec.version || existing?.version || 'latest',
        experience,
      })

      const acsHeaders = { ...headers, 'ACS-Licensing-Ack': spec.licenseAck }

      // acsRequest only sets Authorization/Content-Type/Accept — Splunkbase
      // installs need two MORE headers, so this type talks to fetch directly
      // via a small local helper rather than acsRequest's fixed header set.
      const install = existing === null
        ? await postForm(acs, splunkbaseCollectionPath(experience), buildInstallBody(spec), acsHeaders)
        : await postForm(acs, appPath(experience, spec.appName), buildInstallBody(spec), acsHeaders, 'PATCH')

      if (install.status !== 200 && install.status !== 201 && install.status !== 202) {
        throw new Error(
          `Failed to ${existing === null ? 'install' : 'upgrade'} app "${spec.appName}": ${acsErrorMessage(install)}`,
        )
      }

      const installedBody = parseJson<LiveSplunkbaseApp>(install.body)
      if (installedBody?.status !== TERMINAL_INSTALL_STATUS) {
        const settled = await pollUntilInstalled(acs, experience, spec.appName)
        if (settled === null) pending.push(spec.appName)
        else if (settled.status !== TERMINAL_INSTALL_STATUS) {
          throw new Error(
            `App "${spec.appName}" did not reach the "installed" state (ACS reports "${settled.status ?? 'unknown'}")`,
          )
        }
      }

      deployed.push(spec.appName)
    }

    const pendingNote =
      pending.length > 0 ? ` (${pending.length} still installing: ${pending.join(', ')})` : ''
    return {
      success: true,
      message: `Installed/upgraded ${deployed.length} Splunkbase app(s) on stack "${stack}" (${experience}): ${deployed.join(', ')}${pendingNote}`,
      artifacts: { stack, experience, deployedApps: deployed, pendingApps: pending },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Splunkbase app deployment to stack "${stack}" failed after ${deployed.length} of ${specs.length} app(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { stack, experience, deployedApps: deployed, failedAt: specs[deployed.length]?.appName },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/**
 * POST/PATCH form-encoded to ACS with the two Splunkbase-specific headers
 * (`X-Splunkbase-Authorization`, `ACS-Licensing-Ack`) that `acsRequest`'s
 * fixed JSON header set does not carry.
 */
async function postForm(
  acs: AcsRequestOptions,
  path: string,
  body: string,
  extraHeaders: Record<string, string>,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<{ status: number; ok: boolean; body: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), acs.timeoutMs)
  try {
    const res = await fetch(acsUrl(acs, path), {
      method,
      headers: {
        Authorization: `Bearer ${acs.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...extraHeaders,
      },
      body,
      signal: controller.signal,
    })
    const text = await res.text()
    return { status: res.status, ok: res.ok, body: text }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Poll the app until it reports the terminal "installed" status. A 404 is
 * EXPECTED while the install is in flight, so it is treated as "keep
 * waiting" — mirrors the private-app type's poll loop.
 */
export async function pollUntilInstalled(
  acs: AcsRequestOptions,
  experience: SplunkCloudExperience,
  appName: string,
  { attempts = 12, intervalMs = 5_000 }: { attempts?: number; intervalMs?: number } = {},
): Promise<LiveSplunkbaseApp | null> {
  const path = appPath(experience, appName)

  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await acsRequest(acs, 'GET', path)

    if (res.status === 200) {
      const live = parseJson<LiveSplunkbaseApp>(res.body) ?? {}
      if (live.status !== 'uploaded' && live.status !== 'installing') return live
    } else if (res.status !== 404 && res.status !== 202) {
      throw new Error(`Failed to read app "${appName}" while installing: ${acsErrorMessage(res)}`)
    }

    await sleep(intervalMs)
  }

  return null
}

export { appsBasePath, appPath }
