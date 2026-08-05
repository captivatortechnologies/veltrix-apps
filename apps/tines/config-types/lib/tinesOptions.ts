import type { OptionsProvider, OptionItem } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage, parseJson, type TinesClient } from '../../lib/tinesApi'

/** Cap a live picker's fetch — a searchable field never needs the whole tenant. */
const OPTIONS_LIMIT = 200

interface LiveTeam {
  id?: number | string
  name?: string
}

interface LiveStory {
  id?: number | string
  name?: string
  team_id?: number | string
  slug?: string
}

/**
 * Live options provider for the tines config canvas. Powers `remote-select`
 * fields via GET /api/apps/tines/config-options. The platform resolves the
 * connection and runs this in-process, so it can call the tenant directly
 * with the decrypted API key.
 *
 * Sources:
 *   - "teams"   -> GET /api/v1/teams   (id, name)
 *   - "stories" -> GET /api/v1/stories (id, name, team_id) — used by
 *                  story-settings to pick an EXISTING story; this app never
 *                  creates one (see story-settings/_shared.ts).
 */
const tinesOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  if (ctx.source !== 'teams' && ctx.source !== 'stories') return []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) throw new Error(built.error)
  const { client } = built
  const query = (ctx.query ?? '').trim()

  if (ctx.source === 'teams') return listTeams(client, query)
  return listStories(client, query)
}

async function listTeams(client: TinesClient, query: string): Promise<OptionItem[]> {
  const res = await client.request('GET', '/teams', { query: { per_page: OPTIONS_LIMIT, scope: 'standard' } })
  if (!res.ok) throw new Error(`Failed to list Tines teams: ${tinesErrorMessage(res)}`)
  const env = parseJson<{ teams?: LiveTeam[] }>(res.body)
  const teams = env?.teams ?? []
  const q = query.toLowerCase()
  return teams
    .filter((t) => t.id !== undefined && t.name && (!q || t.name.toLowerCase().includes(q)))
    .map((t) => ({ value: String(t.id), label: t.name as string, description: `id ${t.id}` }))
}

async function listStories(client: TinesClient, query: string): Promise<OptionItem[]> {
  const res = query
    ? await client.request('GET', '/stories', { query: { search: query, per_page: OPTIONS_LIMIT } })
    : await client.request('GET', '/stories', { query: { per_page: OPTIONS_LIMIT } })
  if (!res.ok) throw new Error(`Failed to list Tines stories: ${tinesErrorMessage(res)}`)
  const env = parseJson<{ stories?: LiveStory[] }>(res.body)
  const stories = env?.stories ?? []
  return stories
    .filter((s) => s.id !== undefined && s.name)
    .map((s) => ({ value: s.name as string, label: s.name as string, description: s.slug ? `slug: ${s.slug}` : `id ${s.id}` }))
}

export default tinesOptions
