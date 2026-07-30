import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { getFleetConfig, parseAgentOptions, stableStringify } from './_shared'

/**
 * Drift for agent-config: compare the org agent_options JSON we declare against
 * the live config in Fleet (key order ignored). Best-effort — a config that can't
 * be read, or agentOptions that isn't valid JSON (a validate concern), is skipped
 * rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const item = items[0]
  if (!item) return { hasDrift: false, diffs }

  let expected: unknown
  try {
    expected = parseAgentOptions(item.fields.agentOptions)
  } catch {
    return { hasDrift: false, diffs } // invalid JSON surfaces in validate, not drift
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const live = await getFleetConfig(base, headers)
  if (!live) return { hasDrift: false, diffs } // best-effort: skip when the config can't be read

  const liveOptions = live.agent_options ?? null
  if (stableStringify(liveOptions) !== stableStringify(expected)) {
    diffs.push({ field: 'agent-options.agent_options', expected, actual: liveOptions, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
