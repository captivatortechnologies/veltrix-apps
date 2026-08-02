import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listMonitors, readMonitor } from './deploy'
import {
  deepSubsetEqual,
  extractMonitorSpecs,
  findMonitorByName,
  parseJsonObject,
  parsePriority,
  sameTagSet,
  stableStringify,
  type DatadogMonitor,
} from './_shared'

/**
 * Detect drift between the deployed Monitor configuration and the live
 * organization. Re-finds each declared monitor by name and diffs type /
 * query / message / priority / tags / options (options compared subset-aware
 * — Datadog fills in many option defaults we may not have declared).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractMonitorSpecs(ctx.deployedConfig).filter((s) => s.name && s.type && s.query)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live: DatadogMonitor[]
  try {
    live = await listMonitors(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'datadog',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const label = spec.name
    const found = findMonitorByName(live, spec.name)
    if (!found || typeof found.id !== 'number') {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    let full: DatadogMonitor
    try {
      full = await readMonitor(client, found.id)
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'readable',
        actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'warning',
      })
      continue
    }

    if (spec.type !== (full.type ?? '')) {
      diffs.push({ field: `${label}.type`, expected: spec.type, actual: full.type ?? 'not set', severity: 'warning' })
    }
    if (spec.query !== (full.query ?? '')) {
      diffs.push({ field: `${label}.query`, expected: spec.query, actual: full.query ?? 'not set', severity: 'warning' })
    }
    if (spec.message !== (full.message ?? '')) {
      diffs.push({ field: `${label}.message`, expected: spec.message, actual: full.message ?? 'not set', severity: 'warning' })
    }
    const livePriority = typeof full.priority === 'number' ? full.priority : undefined
    const specPriority = parsePriority(spec.priorityRaw)
    if (!Number.isNaN(specPriority) && specPriority !== livePriority) {
      diffs.push({ field: `${label}.priority`, expected: specPriority ?? 'not set', actual: livePriority ?? 'not set', severity: 'warning' })
    }
    const liveTags = Array.isArray(full.tags) ? full.tags : []
    if (!sameTagSet(spec.tags, liveTags)) {
      diffs.push({ field: `${label}.tags`, expected: spec.tags, actual: liveTags, severity: 'warning' })
    }

    const options = parseJsonObject(spec.optionsRaw)
    if (options.ok && options.value !== undefined && !deepSubsetEqual(options.value, full.options ?? {})) {
      diffs.push({
        field: `${label}.options`,
        expected: stableStringify(options.value),
        actual: stableStringify(full.options ?? {}),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
