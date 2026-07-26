// =============================================================================
// OPTIONS HANDLER — live pickers (remote-select / remote-multiselect fields)
//
// Powers canvas fields whose values come from the tool at edit time instead of
// being free-typed — e.g. "pick an index", "pick a group". The platform:
//   1. resolves the connection (decrypted credential + component +
//      connectivityProvider) for the servers this source pulls from,
//   2. runs this provider IN-PROCESS per server,
//   3. aggregates + de-dupes the results by value.
// A field opts in with `fieldType: remote-select` (stores one id) or
// `remote-multiselect` (stores string[]) + `optionsSource: "<name>"`.
//
// The context carries `component` + `credential` (decrypted) for the server this
// source resolves from, plus `connectivityProvider` whose config has
// `deviceAddress` (the managed-ZTNA tailnet host) when the server is reached over
// the tailnet — build your URL from that, not the raw hostname.
// =============================================================================

import type { OptionItem, OptionsProviderContext } from '@veltrixsecops/app-sdk'

/**
 * Which server roles each source is pulled from (ordered = fallback). The
 * platform resolves the FIRST role tier that has registered servers and queries
 * those — DECOUPLED from where the config deploys. Remove/adjust for your tool;
 * omit the export entirely to resolve from the config type's componentTypes.
 *
 * Example: an index list lives on indexers, so pull it from indexers and fall
 * back to search heads:
 *   export const sourceComponentTypes = { indexes: ['indexer', 'search-head'] }
 */
export const sourceComponentTypes: Record<string, string[]> = {
  // groups: ['server'],
}

export default async function options(ctx: OptionsProviderContext): Promise<OptionItem[]> {
  // No connection yet → return [] so the picker shows its own "save a connection
  // first" guidance rather than erroring.
  if (!ctx.component?.hostname || !ctx.credential) return []

  switch (ctx.source) {
    case 'groups': {
      // Replace with a real call to your tool's API using ctx.credential.
      // const client = createToolClient({ baseUrl, token: ctx.credential.apiToken })
      // const groups = await client.get<{ id: string; name: string }[]>('/groups')
      // const q = (ctx.query ?? '').toLowerCase()
      // return groups
      //   .filter((g) => !q || g.name.toLowerCase().includes(q))
      //   .map((g) => ({ value: g.id, label: g.name }))
      return []
    }
    default:
      return []
  }
}
