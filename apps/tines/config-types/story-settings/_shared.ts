// Shared helpers for the Tines Story Settings config type
// (validate + deploy + rollback + drift + health).
//
// This config type NEVER creates, deletes, or edits a story's GRAPH (its
// agents/links) — only the settings of a story that already exists,
// reconciled by story `name`. See the README Coverage section.
//
// Docs (fetched 2026-08-05): https://www.tines.com/api/stories
//   find:   GET  /api/v1/stories?search=&team_id=  -> { stories: [...], meta }
//   update: PUT  /api/v1/stories/{id}  <- { description?, disabled?, priority?,
//             keep_events_for?, add_tag_names?, remove_tag_names?,
//             monitor_failures?, change_control_enabled?, folder_id? }
//           (every field is documented as optional on Update — inferred to be
//           a PARTIAL update, i.e. an omitted field is left unchanged. Not yet
//           verified against a live tenant — see README.)
//
// EXCLUDED (graph-internal, never sent): send_to_story_* / entry_action_id /
// exit_action_ids / webhook_api_* / api_entry_action_id / api_exit_action_ids
// — all reference action-node ids inside the story graph this app doesn't
// track. `team_id` is accepted only as a search filter — never sent as part
// of the update body, so this app never moves a story between teams.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

const MIN_KEEP_EVENTS_SECONDS = 3600
const MAX_KEEP_EVENTS_SECONDS = 31_536_000
const SECONDS_PER_DAY = 86_400

/** A story as returned by the Tines Stories API (fields this config type reads/writes). */
export interface LiveStory {
  id?: number | string
  name?: string
  team_id?: number | string
  folder_id?: number | string | null
  description?: string
  disabled?: boolean
  priority?: boolean
  keep_events_for?: number
  tags?: string[]
  monitor_failures?: boolean
  change_control_enabled?: boolean
}

/** One canvas item, normalized to the fields this config type manages. */
export interface StorySettingsSpec {
  itemName: string
  storyName: string
  teamId: string
  folderName: string
  disabled: boolean
  priority: boolean
  changeControlEnabled: boolean
  monitorFailures: boolean
  description: string
  keepEventsForDays: number | null
  tags: string[]
}

export function extractStorySettingsSpecs(canvas: CanvasSnapshot): StorySettingsSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    const tagsRaw = fields.tags
    const daysRaw = fields.keep_events_for_days
    return {
      itemName: item.name,
      storyName: typeof fields.story_name === 'string' ? fields.story_name.trim() : '',
      teamId: typeof fields.team_id === 'string' ? fields.team_id.trim() : String(fields.team_id ?? '').trim(),
      folderName: typeof fields.folder_name === 'string' ? fields.folder_name.trim() : '',
      disabled: fields.disabled === true,
      priority: fields.priority === true,
      changeControlEnabled: fields.change_control_enabled === true,
      monitorFailures: fields.monitor_failures === true,
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      keepEventsForDays: typeof daysRaw === 'number' && Number.isFinite(daysRaw) ? daysRaw : null,
      tags: Array.isArray(tagsRaw) ? tagsRaw.map((t) => String(t).trim()).filter(Boolean) : [],
    }
  })
}

/** Convert a day count to the seconds Tines' `keep_events_for` expects, clamped to its documented bounds. */
export function keepEventsForSeconds(days: number): number {
  const seconds = Math.round(days * SECONDS_PER_DAY)
  return Math.min(MAX_KEEP_EVENTS_SECONDS, Math.max(MIN_KEEP_EVENTS_SECONDS, seconds))
}

/** Tag names present in `desired` but not in `live` — passed as Tines' `add_tag_names`. */
export function tagsToAdd(desired: string[], live: string[]): string[] {
  const liveLower = new Set(live.map((t) => t.toLowerCase()))
  return desired.filter((t) => !liveLower.has(t.toLowerCase()))
}

/** Tag names present in `live` but not in `desired` — passed as Tines' `remove_tag_names`. */
export function tagsToRemove(desired: string[], live: string[]): string[] {
  const desiredLower = new Set(desired.map((t) => t.toLowerCase()))
  return live.filter((t) => !desiredLower.has(t.toLowerCase()))
}

/**
 * Build the PUT /stories/{id} body for the settings this config type manages.
 * `folder_id` is included only when resolved from a declared folder_name —
 * team_id is deliberately NEVER included (search-only filter, see above).
 */
export function buildStorySettingsBody(
  spec: StorySettingsSpec,
  addTagNames: string[],
  removeTagNames: string[],
  folderId: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    disabled: spec.disabled,
    priority: spec.priority,
    change_control_enabled: spec.changeControlEnabled,
    monitor_failures: spec.monitorFailures,
  }
  if (spec.description) body.description = spec.description
  if (spec.keepEventsForDays !== null) body.keep_events_for = keepEventsForSeconds(spec.keepEventsForDays)
  if (addTagNames.length > 0) body.add_tag_names = addTagNames
  if (removeTagNames.length > 0) body.remove_tag_names = removeTagNames
  if (folderId) body.folder_id = folderId
  return body
}

/**
 * Find a live story by name, optionally narrowed to a team. Exact,
 * case-insensitive match against Tines' (fuzzy) `search` results.
 */
export function findStoryByName(stories: LiveStory[], name: string): LiveStory | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return stories.find((s) => String(s.name ?? '').trim().toLowerCase() === n) ?? null
}
