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
import {
  extractSelfStorageSpecs,
  locationKey,
  SELF_STORAGE_BUCKETS_PATH,
  type LiveSelfStorageLocation,
} from './validate'

/**
 * Detect drift between the deployed DDSS self storage locations and live ACS
 * state. A declared location missing from the stack is critical (its index rolls
 * would fail). Live locations not declared here are informational — extra
 * registrations are harmless and ACS cannot delete them anyway.
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

  const specs = extractSelfStorageSpecs(ctx.deployedConfig).filter((s) => s.title && s.bucketName)

  try {
    const res = await acsRequest(acs, 'GET', SELF_STORAGE_BUCKETS_PATH)
    if (res.status !== 200) {
      return {
        hasDrift: true,
        diffs: [
          {
            field: 'self-storage-locations',
            expected: 'readable',
            actual: `ACS returned HTTP ${res.status}: ${acsErrorMessage(res)}`,
            severity: 'critical',
          },
        ],
      }
    }

    const parsed = parseJson<
      LiveSelfStorageLocation[] | { selfStorageLocations?: LiveSelfStorageLocation[] }
    >(res.body)
    const live = Array.isArray(parsed) ? parsed : (parsed?.selfStorageLocations ?? [])
    const liveKeys = new Set(live.map((l) => locationKey(l.bucketName ?? '', l.folder ?? '')))
    const liveTitles = new Set(live.map((l) => (l.title ?? '').trim()).filter((t) => t.length > 0))

    const declaredKeys = new Set(specs.map((s) => locationKey(s.bucketName, s.folder)))

    for (const spec of specs) {
      const key = locationKey(spec.bucketName, spec.folder)
      if (!liveKeys.has(key) && !liveTitles.has(spec.title)) {
        diffs.push({
          field: spec.title,
          expected: 'registered',
          actual: 'missing',
          severity: 'critical',
        })
      }
    }

    for (const loc of live) {
      const key = locationKey(loc.bucketName ?? '', loc.folder ?? '')
      if (!declaredKeys.has(key)) {
        diffs.push({
          field: loc.title || loc.bucketPath || loc.bucketName || 'unknown',
          expected: 'not declared',
          actual: 'registered on stack',
          severity: 'info',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'self-storage-locations',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
