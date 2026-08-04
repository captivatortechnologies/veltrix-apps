import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { sidecarCollectorsFromList, findSidecarCollector } from './_shared'

/**
 * Drift for sidecar collectors: compare the executable path, service type and
 * parameters we declare against the live collector in Graylog (matched by the
 * (name, os) pair). Best-effort — a collector that can't be matched is skipped
 * rather than raising false drift. Read-only: GET /api/sidecar/collectors.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = sidecarCollectorsFromList(await getJson<unknown>(`${base}/api/sidecar/collectors`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = asString(item.fields.name)
    const os = asString(item.fields.node_operating_system).toLowerCase()
    const match = findSidecarCollector(live, name, os)
    if (!match) continue

    const label = `${name} (${os})`
    const expectedPath = asString(item.fields.executable_path)
    const actualPath = asString(match.executable_path)
    if (expectedPath !== actualPath) {
      diffs.push({ field: `${label}.executable_path`, expected: expectedPath, actual: actualPath, severity: 'warning' })
    }

    const expectedServiceType = asString(item.fields.service_type || 'exec')
    const actualServiceType = asString(match.service_type)
    if (expectedServiceType !== actualServiceType) {
      diffs.push({ field: `${label}.service_type`, expected: expectedServiceType, actual: actualServiceType, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
