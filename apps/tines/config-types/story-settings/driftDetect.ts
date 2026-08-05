import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildTinesClient } from '../../lib/tinesApi'
import { extractStorySettingsSpecs, keepEventsForSeconds } from './_shared'
import { findStory } from './deploy'

/**
 * Detect drift between the deployed Story Settings and the live Tines
 * tenant. Re-finds each declared story by name:
 *   - a missing story is CRITICAL drift
 *   - disabled / priority / change_control_enabled / monitor_failures /
 *     description / keep_events_for / tag-set mismatches are WARNING drift
 * Best-effort — an unreadable/unsearchable tenant raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractStorySettingsSpecs(ctx.deployedConfig).filter((s) => s.storyName)
  if (specs.length === 0) return { hasDrift: false, diffs }

  for (const spec of specs) {
    let story
    try {
      story = await findStory(client, spec.storyName, spec.teamId || undefined)
    } catch {
      continue
    }
    if (!story) {
      diffs.push({ field: spec.storyName, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (Boolean(story.disabled) !== spec.disabled) {
      diffs.push({ field: `${spec.storyName}.disabled`, expected: spec.disabled, actual: Boolean(story.disabled), severity: 'warning' })
    }
    if (Boolean(story.priority) !== spec.priority) {
      diffs.push({ field: `${spec.storyName}.priority`, expected: spec.priority, actual: Boolean(story.priority), severity: 'warning' })
    }
    if (Boolean(story.change_control_enabled) !== spec.changeControlEnabled) {
      diffs.push({
        field: `${spec.storyName}.change_control_enabled`,
        expected: spec.changeControlEnabled,
        actual: Boolean(story.change_control_enabled),
        severity: 'warning',
      })
    }
    if (Boolean(story.monitor_failures) !== spec.monitorFailures) {
      diffs.push({
        field: `${spec.storyName}.monitor_failures`,
        expected: spec.monitorFailures,
        actual: Boolean(story.monitor_failures),
        severity: 'warning',
      })
    }
    if (spec.description && String(story.description ?? '') !== spec.description) {
      diffs.push({
        field: `${spec.storyName}.description`,
        expected: spec.description,
        actual: String(story.description ?? ''),
        severity: 'info',
      })
    }
    if (spec.keepEventsForDays !== null && story.keep_events_for !== keepEventsForSeconds(spec.keepEventsForDays)) {
      diffs.push({
        field: `${spec.storyName}.keep_events_for`,
        expected: keepEventsForSeconds(spec.keepEventsForDays),
        actual: story.keep_events_for ?? null,
        severity: 'info',
      })
    }
    const liveTagSet = new Set((story.tags ?? []).map((t) => t.toLowerCase()))
    const desiredTagSet = new Set(spec.tags.map((t) => t.toLowerCase()))
    const tagsMatch = liveTagSet.size === desiredTagSet.size && [...desiredTagSet].every((t) => liveTagSet.has(t))
    if (spec.tags.length > 0 && !tagsMatch) {
      diffs.push({ field: `${spec.storyName}.tags`, expected: spec.tags, actual: story.tags ?? [], severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
