import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage, type TinesClient } from '../../lib/tinesApi'
import {
  buildStorySettingsBody,
  extractStorySettingsSpecs,
  findStoryByName,
  tagsToAdd,
  tagsToRemove,
  type LiveStory,
} from './_shared'

/** Per-story rollback record captured during deploy. */
export interface StorySettingsRollbackEntry {
  itemName: string
  storyName: string
  id: string
  prior: LiveStory
  /** Tags this deploy ADDED (undo by removing on rollback). */
  addedTags: string[]
  /** Tags this deploy REMOVED (undo by re-adding on rollback). */
  removedTags: string[]
}

/**
 * Deploy Tines Story SETTINGS over the REST API. This NEVER creates a story —
 * find (GET /api/v1/stories?search=&team_id=) resolves the target by name; a
 * miss FAILS the deploy with an actionable message (author the story's graph
 * in the Tines Story editor, or import it, first). A hit is reconciled via
 * PUT /api/v1/stories/{id} with the settings this config type manages; tags
 * are additive/subtractive (add_tag_names/remove_tag_names), never a full
 * replace. `folder_name`, when set, is resolved against the story's own
 * team's STORY-type folders.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractStorySettingsSpecs(ctx.canvas).filter((s) => s.storyName)
  const rollbackState: StorySettingsRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const story = await findStory(client, spec.storyName, spec.teamId || undefined)
      if (!story || story.id === undefined) {
        throw new Error(
          `Story "${spec.storyName}" was not found${spec.teamId ? ` in team ${spec.teamId}` : ''} — author its graph in the Tines Story editor (or import it) first, then re-deploy this configuration to apply its settings. This config type never creates a story.`,
        )
      }

      let folderId: string | null = null
      if (spec.folderName) {
        folderId = await resolveStoryFolderId(client, String(story.team_id ?? ''), spec.folderName)
        if (!folderId) {
          throw new Error(
            `Story "${spec.storyName}": folder "${spec.folderName}" was not found among team ${story.team_id}'s Story folders (create it first via the Folders config type).`,
          )
        }
      }

      const liveTags = story.tags ?? []
      const addTagNames = tagsToAdd(spec.tags, liveTags)
      const removeTagNames = tagsToRemove(spec.tags, liveTags)
      const body = buildStorySettingsBody(spec, addTagNames, removeTagNames, folderId)

      rollbackState.push({
        itemName: spec.itemName,
        storyName: spec.storyName,
        id: String(story.id),
        prior: story,
        addedTags: addTagNames,
        removedTags: removeTagNames,
      })

      const res = await client.request('PUT', `/stories/${story.id}`, { body })
      if (!res.ok) throw new Error(`Failed to update settings for story "${spec.storyName}": ${tinesErrorMessage(res)}`)
      deployed.push(spec.storyName)
    }

    return {
      success: true,
      message: `Applied settings to ${deployed.length} story(ies): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Story Settings deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Find a story by exact (case-insensitive) name, using Tines' `search` to narrow the candidate set first. */
export async function findStory(client: TinesClient, name: string, teamId?: string): Promise<LiveStory | null> {
  const res = await client.getAll<LiveStory>('/stories', 'stories', {
    search: name,
    team_id: teamId,
  })
  if (!res.ok) {
    throw new Error(`Failed to search stories: ${tinesErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return findStoryByName(res.items, name)
}

/** Resolve a STORY-type folder's name to its live id within a team, or null when not found. */
async function resolveStoryFolderId(client: TinesClient, teamId: string, folderName: string): Promise<string | null> {
  const res = await client.getAll<{ id?: number | string; name?: string }>('/folders', 'folders', {
    team_id: teamId,
    content_type: 'STORY',
  })
  if (!res.ok) return null
  const n = folderName.trim().toLowerCase()
  const found = res.items.find((f) => String(f.name ?? '').trim().toLowerCase() === n)
  return found?.id !== undefined ? String(found.id) : null
}
