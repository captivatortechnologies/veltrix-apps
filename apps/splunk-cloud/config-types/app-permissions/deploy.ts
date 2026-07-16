import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { appPermissionsPath, extractAppPermissionSpecs, PERMISSIONS_APPS_PATH } from './validate'

export interface AppPermissionRollbackEntry {
  appName: string
  /** Did the app have a permissions record BEFORE this deploy? */
  existed: boolean
  /** Read roles assigned before this deploy (rollback restores them). */
  previousRead: string[]
  /** Write roles assigned before this deploy (rollback restores them). */
  previousWrite: string[]
}

/**
 * One app's permissions as ACS returns them. Note the asymmetry: the GET/list
 * response nests the roles under `perms`, but the PATCH request body is flat
 * (`{ read, write }`).
 */
interface LiveAppPermissions {
  name?: string
  perms?: { read?: string[]; write?: string[] }
}

/** GET the full app-permissions list (count=0 → all) and index it by app name. */
async function readLivePerms(
  acs: AcsRequestOptions,
): Promise<Map<string, { read: string[]; write: string[] }>> {
  const res = await acsRequest(acs, 'GET', `${PERMISSIONS_APPS_PATH}?count=0`)
  if (res.status !== 200) {
    throw new Error(`Failed to read app permissions: ${acsErrorMessage(res)}`)
  }
  const parsed = parseJson<{ apps?: LiveAppPermissions[] }>(res.body)
  const byApp = new Map<string, { read: string[]; write: string[] }>()
  for (const item of parsed?.apps ?? []) {
    if (!item.name) continue
    byApp.set(item.name, { read: item.perms?.read ?? [], write: item.perms?.write ?? [] })
  }
  return byApp
}

/**
 * Deploy app permissions to a Splunk Cloud stack via the ACS API.
 *
 * Permissions are declarative, so for each declared app the handler PATCHes the
 * full read[]/write[] role arrays, which REPLACES the app's current assignment:
 *   - GET   /permissions/apps        — read live permissions (also prior state)
 *   - PATCH /permissions/apps/{app}  — set the declared read/write roles
 *
 * ACS app permissions are Victoria-Experience only and require the sc_admin role.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message:
        'No ACS token available — store the Splunk Cloud JWT (sc_admin) in the credential "API token" field',
    }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const specs = extractAppPermissionSpecs(ctx.canvas).filter((s) => s.appName)
  const rollbackState: AppPermissionRollbackEntry[] = []
  const summary: string[] = []

  try {
    const live = await readLivePerms(acs)

    for (const spec of specs) {
      const prev = live.get(spec.appName)

      const res = await acsRequest(acs, 'PATCH', appPermissionsPath(spec.appName), {
        read: spec.readRoles,
        write: spec.writeRoles,
      })
      if (res.status !== 200 && res.status !== 202) {
        throw new Error(`Failed to update permissions for app "${spec.appName}": ${acsErrorMessage(res)}`)
      }

      rollbackState.push({
        appName: spec.appName,
        existed: prev !== undefined,
        previousRead: prev?.read ?? [],
        previousWrite: prev?.write ?? [],
      })
      summary.push(`${spec.appName}: r${spec.readRoles.length}/w${spec.writeRoles.length}`)
    }

    return {
      success: true,
      message: `Reconciled permissions for ${specs.length} app(s) on stack "${stack}" (${summary.join(', ')})`,
      artifacts: {
        stack,
        experience: settings.experience,
        apps: specs.map((s) => s.appName),
        changes: rollbackState,
      },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `App-permission deployment to stack "${stack}" failed after ${rollbackState.length} of ${specs.length} app(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { stack, changes: rollbackState },
      rollbackData: { previousState: rollbackState },
    }
  }
}
