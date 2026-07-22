import type { OptionsProvider, OptionItem } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import type { LiveGroup } from '../groups/validate'

/** OKTA_GROUP is the only group type worth offering as a scoping target. */
const OKTA_GROUP_TYPE = 'OKTA_GROUP'
/** Cap the picker's live fetch — a searchable field never needs the whole org. */
const OPTIONS_LIMIT = 200
const SEARCH_LIMIT = 50

interface LiveUser {
  id?: string
  status?: string
  profile?: { firstName?: string; lastName?: string; email?: string; login?: string }
}

interface LiveZone {
  id?: string
  name?: string
  type?: string
  status?: string
}

/** A readable label for a user option: "First Last (email)", falling back sensibly. */
function userLabel(u: LiveUser): string {
  const name = [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ').trim()
  const email = u.profile?.email || u.profile?.login
  if (name && email) return `${name} (${email})`
  return name || email || (u.id as string)
}

/**
 * Declarative spec for a "simple list" source: fetch a page from `path`, pull the
 * array out (top-level, or unwrapped from `wrapperKey`), and map each record to an
 * option. `query` filters server-side when `supportsQ`, otherwise in memory on the
 * label. Keeps the many single-object pickers (apps, auth servers, brands, …) to
 * one line of config each.
 */
interface SimpleSource {
  path: string
  extraQuery?: Record<string, string>
  supportsQ?: boolean
  wrapperKey?: string
  toOption: (raw: Record<string, unknown>) => OptionItem | null
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const opt = (id: unknown, label: unknown, description?: unknown): OptionItem | null => {
  const value = str(id)
  if (!value) return null
  return { value, label: str(label) || value, description: str(description) || value }
}

const SIMPLE_SOURCES: Record<string, SimpleSource> = {
  apps: {
    path: '/apps',
    supportsQ: true,
    toOption: (a) => opt(a.id, a.label ?? a.name, a.status),
  },
  authServers: {
    path: '/authorizationServers',
    supportsQ: true,
    toOption: (s) => opt(s.id, s.name, s.audiences ? undefined : s.id),
  },
  brands: {
    path: '/brands',
    toOption: (b) => opt(b.id, b.name, b.id),
  },
  emailDomains: {
    path: '/email-domains',
    toOption: (d) => opt(d.id, d.domain, d.validationStatus),
  },
  accessPolicies: {
    path: '/policies',
    extraQuery: { type: 'ACCESS_POLICY' },
    toOption: (p) => opt(p.id, p.name, p.id),
  },
  resourceSets: {
    path: '/iam/resource-sets',
    wrapperKey: 'resource-sets',
    toOption: (r) => opt(r.id, r.label, r.description),
  },
  userTypes: {
    path: '/meta/types/user',
    toOption: (t) => opt(t.id, t.displayName ?? t.name, t.name),
  },
}

/** Sources this provider knows how to resolve (custom + declarative). */
const SUPPORTED_SOURCES = new Set(['groups', 'users', 'zones', ...Object.keys(SIMPLE_SOURCES)])

/**
 * Live options provider for the okta-identity config canvas. Powers
 * `remote-multiselect` and `remote-select` fields via
 * GET /api/apps/okta-identity/config-options. The platform resolves the
 * connection and runs this in-process, so it can call the Okta org directly with
 * the decrypted credential.
 *
 * Sources: groups, users, zones (custom); apps, authServers, brands, emailDomains,
 * accessPolicies, resourceSets, userTypes (declarative — see SIMPLE_SOURCES). Each
 * returns { value: id, label: name }. A `query` narrows the result server-side
 * where the endpoint supports Okta's `q`, otherwise in memory on the label.
 */
const oktaOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  if (!SUPPORTED_SOURCES.has(ctx.source)) return []

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

  if (ctx.source === 'users') return listUsers(client, query)
  if (ctx.source === 'zones') return listZones(client, query)
  if (ctx.source === 'groups') return listGroups(client, query)
  return listSimple(client, SIMPLE_SOURCES[ctx.source], query)
}

async function listGroups(client: OktaClient, query: string): Promise<OptionItem[]> {
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

async function listUsers(client: OktaClient, query: string): Promise<OptionItem[]> {
  // `q` startsWith-matches firstName / lastName / email — the same field Okta's
  // People search uses. Without a query, return the first page of org users.
  const res = query
    ? await client.request('GET', '/users', { query: { q: query, limit: SEARCH_LIMIT } })
    : await client.request('GET', '/users', { query: { limit: OPTIONS_LIMIT } })
  if (!res.ok) {
    throw new Error(`Failed to list Okta users: ${oktaErrorMessage(res)}`)
  }
  const users = parseJson<LiveUser[]>(res.body) ?? []
  return users
    .filter((u) => u.id)
    .map((u) => ({ value: u.id as string, label: userLabel(u), description: u.id }))
}

async function listZones(client: OktaClient, query: string): Promise<OptionItem[]> {
  // The Zones API has no `q`; list the first page and narrow by name in memory.
  const res = await client.request('GET', '/zones', { query: { limit: OPTIONS_LIMIT } })
  if (!res.ok) {
    throw new Error(`Failed to list Okta network zones: ${oktaErrorMessage(res)}`)
  }
  const q = query.toLowerCase()
  const zones = parseJson<LiveZone[]>(res.body) ?? []
  return zones
    .filter((z) => z.id && z.name && (!q || z.name.toLowerCase().includes(q)))
    .map((z) => ({ value: z.id as string, label: z.name as string, description: z.type ?? z.id }))
}

async function listSimple(
  client: OktaClient,
  spec: SimpleSource,
  query: string,
): Promise<OptionItem[]> {
  const q: Record<string, string> = { limit: String(spec.supportsQ && query ? SEARCH_LIMIT : OPTIONS_LIMIT) }
  if (spec.extraQuery) Object.assign(q, spec.extraQuery)
  if (spec.supportsQ && query) q.q = query

  const res = await client.request('GET', spec.path, { query: q })
  if (!res.ok) {
    throw new Error(`Failed to list Okta options (${spec.path}): ${oktaErrorMessage(res)}`)
  }

  const parsed = parseJson<unknown>(res.body)
  const rows: Array<Record<string, unknown>> = Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>)
    : spec.wrapperKey && parsed && typeof parsed === 'object'
      ? (((parsed as Record<string, unknown>)[spec.wrapperKey] as Array<Record<string, unknown>>) ?? [])
      : []

  const needle = query.toLowerCase()
  const items = rows.map(spec.toOption).filter((o): o is OptionItem => o !== null)
  // Endpoints without server-side `q` are filtered on the label in memory.
  return spec.supportsQ || !needle
    ? items
    : items.filter((o) => o.label.toLowerCase().includes(needle))
}

export default oktaOptions
