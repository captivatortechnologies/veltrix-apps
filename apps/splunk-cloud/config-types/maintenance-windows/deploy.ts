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
import { extractMaintenanceWindowSpec, PREFERENCES_PATH, type MaintenanceWindowSpec } from './validate'

/** A change freeze object as stored under maintenance-windows/preferences. */
export interface ChangeFreeze {
  /** Server-assigned; omitted when creating a new freeze. */
  id?: string
  startDate: string
  endDate: string
  appliesTo: string
  reason?: string
  tickets?: string[]
  category?: string
  createdTimestamp?: string
  lastModifiedTimestamp?: string
}

/** Shape of GET /maintenance-windows/preferences. */
export interface ChangeFreezePreferences {
  changeFreezes?: {
    customerInitiatedFreezes?: ChangeFreeze[]
    splunkInitiatedFreezes?: ChangeFreeze[]
  }
  /** Optimistic-concurrency token — echoed unchanged on the next PUT. */
  recordVersion?: number
}

/**
 * Prior customer-initiated state captured for rollback. `recordVersion` is only
 * the value seen at deploy time — rollback re-reads the CURRENT one before its
 * PUT, since deploy incremented it.
 */
export interface MaintenanceWindowRollbackState {
  recordVersion: number
  customerInitiatedFreezes: ChangeFreeze[]
}

/** Read the live change-freeze preferences (recordVersion + freeze lists). */
async function readPreferences(acs: AcsRequestOptions): Promise<ChangeFreezePreferences> {
  const res = await acsRequest(acs, 'GET', PREFERENCES_PATH)
  if (res.status !== 200) {
    throw new Error(`Failed to read change-freeze preferences: ${acsErrorMessage(res)}`)
  }
  return parseJson<ChangeFreezePreferences>(res.body) ?? {}
}

/** Build the customer-initiated change freeze declared by the canvas. */
function toChangeFreeze(spec: MaintenanceWindowSpec): ChangeFreeze {
  const freeze: ChangeFreeze = {
    startDate: spec.startDate,
    endDate: spec.endDate,
    appliesTo: spec.appliesTo,
    reason: spec.reason,
  }
  if (spec.tickets.length > 0) freeze.tickets = spec.tickets
  return freeze
}

/** Two freezes cover the same window when their start and end dates match. */
function sameWindow(a: ChangeFreeze, b: ChangeFreeze): boolean {
  return a.startDate === b.startDate && a.endDate === b.endDate
}

/** A live freeze already matches the declared one (window + appliesTo + reason). */
function isUnchanged(live: ChangeFreeze, desired: ChangeFreeze): boolean {
  return (
    sameWindow(live, desired) &&
    live.appliesTo === desired.appliesTo &&
    (live.reason ?? '') === (desired.reason ?? '')
  )
}

/**
 * Deploy the declared change freeze to a Splunk Cloud stack via the ACS API.
 *
 *   - GET /maintenance-windows/preferences — read live freezes + recordVersion
 *   - PUT /maintenance-windows/preferences — write the full customer-initiated
 *     list with the SAME recordVersion (optimistic concurrency; 204 on success)
 *
 * The declared freeze is upserted into the customer-initiated list, matched on
 * its start/end window: created when absent, updated in place when its scope or
 * reason changed, and skipped when already identical. Any OTHER customer freezes
 * are preserved. The prior list is captured in rollbackData.previousState.
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

  const spec = extractMaintenanceWindowSpec(ctx.canvas)
  if (!spec.startDate || !spec.endDate || !spec.appliesTo) {
    return {
      success: false,
      message: 'No change freeze declared — set start date, end date and applies-to scope before deploying',
    }
  }

  try {
    const prefs = await readPreferences(acs)
    const recordVersion = prefs.recordVersion ?? 0
    const existing = prefs.changeFreezes?.customerInitiatedFreezes ?? []

    // Capture prior customer-initiated state for rollback.
    const previousState: MaintenanceWindowRollbackState = {
      recordVersion,
      customerInitiatedFreezes: existing,
    }

    const desired = toChangeFreeze(spec)
    const match = existing.find((f) => sameWindow(f, desired))

    let action: 'created' | 'updated' | 'unchanged'
    let nextFreezes: ChangeFreeze[]
    if (!match) {
      // Create: append with `id` omitted per the ACS create contract.
      action = 'created'
      nextFreezes = [...existing, desired]
    } else if (isUnchanged(match, desired)) {
      action = 'unchanged'
      nextFreezes = existing
    } else {
      // Update in place, keeping the server-assigned id.
      action = 'updated'
      nextFreezes = existing.map((f) => (sameWindow(f, desired) ? { ...desired, id: match.id } : f))
    }

    if (action !== 'unchanged') {
      const res = await acsRequest(acs, 'PUT', PREFERENCES_PATH, {
        changeFreezes: { customerInitiatedFreezes: nextFreezes },
        recordVersion,
      })
      if (res.status !== 200 && res.status !== 202 && res.status !== 204) {
        throw new Error(`Failed to update change-freeze preferences: ${acsErrorMessage(res)}`)
      }
    }

    return {
      success: true,
      message: `Change freeze ${spec.startDate}–${spec.endDate} ${action} on stack "${stack}" (appliesTo: ${spec.appliesTo})`,
      artifacts: {
        stack,
        experience: settings.experience,
        action,
        changeFreeze: desired,
        recordVersion,
      },
      rollbackData: { previousState },
    }
  } catch (error) {
    // A failed PUT is atomic — ACS applied nothing — so there is nothing to roll
    // back and no rollbackData to emit.
    return {
      success: false,
      message: `Change freeze deployment to stack "${stack}" failed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { stack },
    }
  }
}
