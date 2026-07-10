import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  parseJson,
  pollUntilReady,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { extractIndexSpecs, type IndexSpec, type LiveIndex } from './validate'

/** ACS fields that can be changed on an existing index via PATCH. */
const PATCHABLE_FIELDS = [
  'searchableDays',
  'maxDataSizeMB',
  'splunkArchivalRetentionDays',
  'selfStorageBucketPath',
] as const

export interface IndexRollbackEntry {
  name: string
  existed: boolean
  prior?: Partial<Pick<LiveIndex, (typeof PATCHABLE_FIELDS)[number]>>
}

/**
 * Deploy index configurations to a Splunk Cloud stack via the ACS API.
 *
 * For each declared index:
 *   - GET  /adminconfig/v2/indexes/{name}  — capture prior state for rollback
 *   - PATCH /adminconfig/v2/indexes/{name} — update existing (updatable fields only)
 *   - POST  /adminconfig/v2/indexes        — create missing, then poll until ready
 *
 * `datatype` is immutable via ACS, so a mismatch on an existing index fails
 * the deployment rather than silently diverging from the declared state.
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

  const specs = extractIndexSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: IndexRollbackEntry[] = []
  const deployed: string[] = []
  const pending: string[] = []

  try {
    for (const spec of specs) {
      const encoded = encodeURIComponent(spec.name)
      const current = await acsRequest(acs, 'GET', `/indexes/${encoded}`)

      if (current.status === 200) {
        const live = parseJson<LiveIndex>(current.body) ?? {}

        if (live.datatype && spec.datatype !== live.datatype) {
          throw new Error(
            `Index "${spec.name}": datatype is immutable via ACS (live "${live.datatype}", canvas "${spec.datatype}"). ` +
              'Delete and recreate the index to change its datatype.',
          )
        }

        rollbackState.push({
          name: spec.name,
          existed: true,
          prior: {
            searchableDays: live.searchableDays,
            maxDataSizeMB: live.maxDataSizeMB,
            splunkArchivalRetentionDays: live.splunkArchivalRetentionDays,
            selfStorageBucketPath: live.selfStorageBucketPath,
          },
        })

        const patch = buildPatch(spec, live)
        if (Object.keys(patch).length > 0) {
          const res = await acsRequest(acs, 'PATCH', `/indexes/${encoded}`, patch)
          if (res.status !== 200 && res.status !== 202) {
            throw new Error(`Failed to update index "${spec.name}": ${acsErrorMessage(res)}`)
          }
        }
      } else if (current.status === 404) {
        const res = await acsRequest(acs, 'POST', '/indexes', buildCreatePayload(spec))
        if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
          throw new Error(`Failed to create index "${spec.name}": ${acsErrorMessage(res)}`)
        }
        rollbackState.push({ name: spec.name, existed: false })

        // Index creation is asynchronous — poll until the index answers 200.
        const ready = await pollUntilReady(acs, `/indexes/${encoded}`)
        if (ready === null) {
          pending.push(spec.name)
        } else if (ready.status !== 200) {
          throw new Error(`Index "${spec.name}" failed to provision: ${acsErrorMessage(ready)}`)
        }
      } else {
        throw new Error(`Failed to read index "${spec.name}": ${acsErrorMessage(current)}`)
      }

      deployed.push(spec.name)
    }

    const pendingNote =
      pending.length > 0
        ? ` (${pending.length} still provisioning: ${pending.join(', ')})`
        : ''
    return {
      success: true,
      message: `Deployed ${deployed.length} index(es) to stack "${stack}": ${deployed.join(', ')}${pendingNote}`,
      artifacts: {
        stack,
        experience: settings.experience,
        deployedIndexes: deployed,
        pendingIndexes: pending,
      },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Index deployment to stack "${stack}" failed after ${deployed.length} of ${specs.length} index(es): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { stack, deployedIndexes: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

function buildCreatePayload(spec: IndexSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: spec.name, datatype: spec.datatype }
  if (spec.searchableDays !== undefined) payload.searchableDays = spec.searchableDays
  if (spec.maxDataSizeMB !== undefined) payload.maxDataSizeMB = spec.maxDataSizeMB
  if (spec.splunkArchivalRetentionDays !== undefined && spec.splunkArchivalRetentionDays > 0) {
    payload.splunkArchivalRetentionDays = spec.splunkArchivalRetentionDays
  }
  if (spec.selfStorageBucketPath) payload.selfStorageBucketPath = spec.selfStorageBucketPath
  return payload
}

function buildPatch(spec: IndexSpec, live: LiveIndex): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (spec.searchableDays !== undefined && spec.searchableDays !== live.searchableDays) {
    patch.searchableDays = spec.searchableDays
  }
  if (spec.maxDataSizeMB !== undefined && spec.maxDataSizeMB !== live.maxDataSizeMB) {
    patch.maxDataSizeMB = spec.maxDataSizeMB
  }
  if (
    spec.splunkArchivalRetentionDays !== undefined &&
    spec.splunkArchivalRetentionDays > 0 &&
    spec.splunkArchivalRetentionDays !== live.splunkArchivalRetentionDays
  ) {
    patch.splunkArchivalRetentionDays = spec.splunkArchivalRetentionDays
  }
  if (spec.selfStorageBucketPath && spec.selfStorageBucketPath !== live.selfStorageBucketPath) {
    patch.selfStorageBucketPath = spec.selfStorageBucketPath
  }
  return patch
}
