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
import {
  extractSelfStorageSpecs,
  locationKey,
  SELF_STORAGE_BUCKETS_PATH,
  type LiveSelfStorageLocation,
} from './validate'

export interface SelfStorageRollbackEntry {
  title: string
  bucketName: string
  folder: string
  /** bucketPath ACS returned at creation, used as the delete identifier on rollback. */
  bucketPath?: string
  /** True if the location already existed before this deploy — rollback leaves it. */
  existed: boolean
}

/** GET the live self storage locations, tolerating a bare array or a `selfStorageLocations` wrapper. */
async function readLiveLocations(acs: AcsRequestOptions): Promise<LiveSelfStorageLocation[]> {
  const res = await acsRequest(acs, 'GET', SELF_STORAGE_BUCKETS_PATH)
  if (res.status !== 200) {
    throw new Error(`Failed to read self storage locations: ${acsErrorMessage(res)}`)
  }
  const parsed = parseJson<
    LiveSelfStorageLocation[] | { selfStorageLocations?: LiveSelfStorageLocation[] }
  >(res.body)
  return Array.isArray(parsed) ? parsed : (parsed?.selfStorageLocations ?? [])
}

/**
 * Deploy DDSS self storage locations to a Splunk Cloud stack via the ACS API.
 *
 * ACS self storage locations are CREATE-ONLY (no modify, no delete), so this
 * reconcile is purely additive and idempotent:
 *   - GET  /cloud-resources/self-storage-locations/buckets — read live locations
 *   - POST /cloud-resources/self-storage-locations/buckets — register each
 *     declared location that is not already present (matched by bucket+folder or
 *     by title).
 *
 * The bucket itself must already exist in the same cloud region as the stack,
 * with the ACS-generated IAM policy (AWS) / service accounts (GCP) applied — ACS
 * registers the location, it does not provision the bucket.
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

  const specs = extractSelfStorageSpecs(ctx.canvas).filter((s) => s.title && s.bucketName)
  const rollbackState: SelfStorageRollbackEntry[] = []
  const created: string[] = []
  const skipped: string[] = []

  try {
    const live = await readLiveLocations(acs)
    const liveKeys = new Set(live.map((l) => locationKey(l.bucketName ?? '', l.folder ?? '')))
    const liveTitles = new Set(
      live.map((l) => (l.title ?? '').trim()).filter((t) => t.length > 0),
    )

    for (const spec of specs) {
      const key = locationKey(spec.bucketName, spec.folder)
      if (liveKeys.has(key) || liveTitles.has(spec.title)) {
        rollbackState.push({
          title: spec.title,
          bucketName: spec.bucketName,
          folder: spec.folder,
          existed: true,
        })
        skipped.push(spec.title)
        continue
      }

      const body: Record<string, unknown> = { title: spec.title, bucketName: spec.bucketName }
      if (spec.folder) body.folder = spec.folder
      if (spec.description) body.description = spec.description

      const res = await acsRequest(acs, 'POST', SELF_STORAGE_BUCKETS_PATH, body)
      if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
        throw new Error(`Failed to register self storage location "${spec.title}": ${acsErrorMessage(res)}`)
      }

      const createdBody = parseJson<LiveSelfStorageLocation>(res.body)
      rollbackState.push({
        title: spec.title,
        bucketName: spec.bucketName,
        folder: spec.folder,
        bucketPath: createdBody?.bucketPath,
        existed: false,
      })
      created.push(spec.title)
      // Track it so a later spec pointing at the same bucket is treated as existing.
      liveKeys.add(key)
      liveTitles.add(spec.title)
    }

    const skippedNote = skipped.length > 0 ? ` (${skipped.length} already registered: ${skipped.join(', ')})` : ''
    return {
      success: true,
      message: `Registered ${created.length} DDSS self storage location(s) on stack "${stack}"${
        created.length > 0 ? `: ${created.join(', ')}` : ''
      }${skippedNote}`,
      artifacts: {
        stack,
        experience: settings.experience,
        created,
        skipped,
        locations: specs.map((s) => ({ title: s.title, bucketName: s.bucketName, folder: s.folder })),
      },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `DDSS self storage deployment to stack "${stack}" failed after ${created.length} of ${specs.length} location(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { stack, created },
      rollbackData: { previousState: rollbackState },
    }
  }
}
