import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, verifyTls } from '../../lib/axoniusApi'
import { INSTANCES_LIST_RESOURCE, instancesFromResponse, findInstance, parseText, parseBool } from './_shared'

/**
 * Drift for instances: confirm each declared node_id still exists and compare
 * node_name / hostname / use_as_environment_name against the live instance.
 * Read-only: GET api/instances. Best-effort — a transient read error raises no
 * false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) return { hasDrift: false, diffs }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)

  let live
  try {
    live = instancesFromResponse(await getJson<unknown>(apiUrl(base, settings, INSTANCES_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read instances, no drift asserted
  }

  for (const item of items) {
    const nodeId = parseText(item.fields.node_id)
    if (!nodeId) continue
    const match = findInstance(live, nodeId)

    if (!match) {
      diffs.push({ field: `${nodeId}.exists`, expected: true, actual: false, severity: 'critical' })
      continue
    }

    const expectedName = parseText(item.fields.node_name)
    const actualName = String(match.node_name ?? '').trim()
    if (expectedName !== actualName) {
      diffs.push({ field: `${nodeId}.node_name`, expected: expectedName, actual: actualName, severity: 'warning' })
    }

    const expectedHostname = parseText(item.fields.hostname)
    const actualHostname = String(match.hostname ?? '').trim()
    if (expectedHostname && expectedHostname !== actualHostname) {
      diffs.push({ field: `${nodeId}.hostname`, expected: expectedHostname, actual: actualHostname, severity: 'info' })
    }

    const expectedEnv = parseBool(item.fields.use_as_environment_name)
    const actualEnv = match.use_as_environment_name === true
    if (expectedEnv !== actualEnv) {
      diffs.push({ field: `${nodeId}.use_as_environment_name`, expected: expectedEnv, actual: actualEnv, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
