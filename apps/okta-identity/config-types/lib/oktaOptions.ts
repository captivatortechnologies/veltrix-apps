import type { OptionsProvider, OptionItem } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson } from '../../lib/okta'
import type { LiveGroup } from '../groups/validate'

/** OKTA_GROUP is the only group type worth offering as a scoping target. */
const OKTA_GROUP_TYPE = 'OKTA_GROUP'
/** Cap the picker's live fetch — a searchable field never needs the whole org. */
const OPTIONS_LIMIT = 200
const SEARCH_LIMIT = 50

/**
 * Live options provider for the okta-identity config canvas. Powers
 * `remote-multiselect` fields via GET /api/apps/okta-identity/config-options.
 * The platform resolves the connection and runs this in-process, so it can call
 * the Okta org directly with the decrypted credential.
 *
 * Sources:
 *   - "groups": OKTA_GROUP groups → { value: id, label: name }. When the field
 *     passes a `query`, Okta's `q` (name startsWith) narrows it; otherwise the
 *     first page of OKTA_GROUP groups is returned.
 */
const oktaOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  if (ctx.source !== 'groups') return []

  if (!ctx.component?.hostname) {
    throw new Error(
      'No Okta deploy target is registered for this connection yet — save the connection first.',
    )
  }

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    throw new Error(built.error)
  }
  const { client } = built

  const query = (ctx.query ?? '').trim()
  // `q` searches names across ALL group types, so filter to OKTA_GROUP after.
  // Without a query, list the first page filtered to OKTA_GROUP directly.
  const res = query
    ? await client.request('GET', '/groups', { query: { q: query, limit: SEARCH_LIMIT } })
    : await client.request('GET', '/groups', {
        query: { filter: `type eq "${OKTA_GROUP_TYPE}"`, limit: OPTIONS_LIMIT },
      })

  if (!res.ok) {
    throw new Error(`Failed to list Okta groups: ${oktaErrorMessage(res)}`)
  }

  const groups = parseJson<LiveGroup[]>(res.body) ?? []
  return groups
    .filter((g) => g.type === OKTA_GROUP_TYPE && g.id && g.profile?.name)
    .map((g) => ({ value: g.id as string, label: g.profile?.name as string, description: g.id }))
}

export default oktaOptions
