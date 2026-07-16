import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { extractAppPermissionSpecs, PERMISSIONS_APPS_PATH } from './validate'

interface LiveAppPermissions {
  name?: string
  perms?: { read?: string[]; write?: string[] }
}

/**
 * Detect drift between the deployed app permissions and live ACS state.
 * Declared roles missing from the live assignment are critical; live roles not
 * declared are warnings — the next deploy's PATCH would remove them, since a
 * permissions PATCH fully replaces the app's read/write arrays.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return { hasDrift: false, diffs: [] }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const specs = extractAppPermissionSpecs(ctx.deployedConfig).filter((s) => s.appName)

  try {
    const res = await acsRequest(acs, 'GET', `${PERMISSIONS_APPS_PATH}?count=0`)
    if (res.status !== 200) {
      return {
        hasDrift: true,
        diffs: [
          {
            field: 'app-permissions',
            expected: 'readable',
            actual: `ACS returned HTTP ${res.status}: ${acsErrorMessage(res)}`,
            severity: 'critical',
          },
        ],
      }
    }
    const parsed = parseJson<{ apps?: LiveAppPermissions[] }>(res.body)
    const liveByApp = new Map<string, { read: string[]; write: string[] }>()
    for (const item of parsed?.apps ?? []) {
      if (!item.name) continue
      liveByApp.set(item.name, { read: item.perms?.read ?? [], write: item.perms?.write ?? [] })
    }

    for (const spec of specs) {
      const live = liveByApp.get(spec.appName)
      if (!live) {
        diffs.push({
          field: spec.appName,
          expected: 'app permissions present',
          actual: 'app not found on stack',
          severity: 'critical',
        })
        continue
      }
      diffRoleList(spec.appName, 'readRoles', spec.readRoles, live.read, diffs)
      diffRoleList(spec.appName, 'writeRoles', spec.writeRoles, live.write, diffs)
    }
  } catch (error) {
    diffs.push({
      field: 'app-permissions',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Compare one declared role list against the live one for a single app. */
function diffRoleList(
  appName: string,
  kind: string,
  declared: string[],
  live: string[],
  diffs: DriftDiff[],
): void {
  for (const role of declared) {
    if (!live.includes(role)) {
      diffs.push({ field: `${appName}.${kind}`, expected: role, actual: 'missing', severity: 'critical' })
    }
  }
  for (const role of live) {
    if (!declared.includes(role)) {
      diffs.push({ field: `${appName}.${kind}`, expected: 'not declared', actual: role, severity: 'warning' })
    }
  }
}
