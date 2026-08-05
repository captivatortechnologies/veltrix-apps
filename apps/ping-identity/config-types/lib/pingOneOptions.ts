import type { OptionItem, OptionsProvider } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage, type PingOneClient } from '../../lib/pingOne'

/** Cap a picker's live fetch - a searchable field never needs the whole environment. */
const OPTIONS_LIMIT = 200

interface HalListResponse<T> {
  _embedded?: Record<string, T[]>
}

/**
 * Declarative spec for a "list one page, map to options" source: GET `path`,
 * pull the array out of `_embedded[wrapperKey]` (every PingOne list response
 * is a HAL document), and map each record to an option. PingOne's list
 * endpoints do not support a generic free-text `filter`/`q` for most
 * resources, so narrowing happens in memory on the label.
 */
interface SimpleSource {
  path: string
  wrapperKey: string
  toOption: (raw: Record<string, unknown>) => OptionItem | null
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const opt = (id: unknown, label: unknown, description?: unknown): OptionItem | null => {
  const value = str(id)
  if (!value) return null
  return { value, label: str(label) || value, description: str(description) }
}

/** A nested `{ id, name }` reference object, as PingOne embeds e.g. `resource`. */
function refName(raw: unknown): string | undefined {
  if (raw && typeof raw === 'object') return str((raw as Record<string, unknown>).name)
  return undefined
}

const SIMPLE_SOURCES: Record<string, SimpleSource> = {
  populations: {
    path: '/populations',
    wrapperKey: 'populations',
    toOption: (p) => opt(p.id, p.name, p.default ? 'Default population' : undefined),
  },
  resources: {
    path: '/resources',
    wrapperKey: 'resources',
    toOption: (r) => opt(r.id, r.name, r.type === 'CUSTOM' ? 'Custom resource' : (r.type as string)),
  },
  signOnPolicies: {
    path: '/signOnPolicies',
    wrapperKey: 'signOnPolicies',
    toOption: (p) => opt(p.id, p.name, p.default ? 'Default policy' : undefined),
  },
  groups: {
    path: '/groups',
    wrapperKey: 'groups',
    toOption: (g) => opt(g.id, g.name, refName(g.population)),
  },
  identityProviders: {
    path: '/identityProviders',
    wrapperKey: 'identityProviders',
    toOption: (i) => opt(i.id, i.name, i.type as string),
  },
  mfaDevicePolicies: {
    path: '/deviceAuthenticationPolicies',
    wrapperKey: 'deviceAuthenticationPolicies',
    toOption: (m) => opt(m.id, m.name, m.default ? 'Default MFA policy' : undefined),
  },
  passwordPolicies: {
    path: '/passwordPolicies',
    wrapperKey: 'passwordPolicies',
    toOption: (p) => opt(p.id, p.name, p.default ? 'Default policy' : undefined),
  },
  applications: {
    path: '/applications',
    wrapperKey: 'applications',
    toOption: (a) => opt(a.id, a.name, a.protocol as string),
  },
  riskPredictors: {
    path: '/riskPredictors',
    wrapperKey: 'riskPredictors',
    toOption: (p) => opt(p.id, p.name, p.compactName as string),
  },
}

const SUPPORTED_SOURCES = new Set(Object.keys(SIMPLE_SOURCES))

/**
 * Live options provider shared by every ping-identity config type. Powers
 * `remote-select` / `remote-multiselect` canvas fields via
 * GET /api/apps/ping-identity/config-options. The platform resolves the
 * connection and runs this in-process, so it can call the PingOne
 * environment directly with the decrypted worker credential.
 *
 * Sources: populations, resources, signOnPolicies, groups, identityProviders,
 * mfaDevicePolicies, passwordPolicies, applications - each a direct
 * `GET /environments/{id}/<resource>` list (see pingOne.ts client for the
 * exact HAL response shape), mapped to `{ value: id, label: name }`.
 */
const pingOneOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  if (!SUPPORTED_SOURCES.has(ctx.source)) return []

  const built = buildPingOneClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) throw new Error(built.error)
  const { client } = built

  const items = await listSimple(client, SIMPLE_SOURCES[ctx.source])
  const query = (ctx.query ?? '').trim().toLowerCase()
  return query ? items.filter((o) => o.label.toLowerCase().includes(query)) : items
}

async function listSimple(client: PingOneClient, spec: SimpleSource): Promise<OptionItem[]> {
  const res = await client.request('GET', spec.path, { query: { limit: OPTIONS_LIMIT } })
  if (!res.ok) {
    throw new Error(`Failed to list PingOne options (${spec.path}): ${pingOneErrorMessage(res)}`)
  }
  const parsed = parseJson<HalListResponse<Record<string, unknown>>>(res.body)
  const rows = parsed?._embedded?.[spec.wrapperKey] ?? []
  return rows.map(spec.toOption).filter((o): o is OptionItem => o !== null)
}

export default pingOneOptions
