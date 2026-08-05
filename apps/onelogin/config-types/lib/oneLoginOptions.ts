import type { OptionItem, OptionsProvider } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, oneLoginErrorMessage, type OneLoginClient } from '../../lib/oneLogin'

/** Cap a picker's live fetch - a searchable field never needs the whole account. */
const OPTIONS_LIMIT = 200

/**
 * Declarative spec for a "list one v2 endpoint, map to options" source. Every
 * source here is a bare-array v2 list response (see lib/oneLogin.ts header) -
 * OneLogin's list endpoints do not support a generic free-text `filter`/`q`
 * for these resources, so narrowing happens in memory on the label.
 */
interface SimpleSource {
  path: string
  toOption: (raw: Record<string, unknown>) => OptionItem | null
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined)

const opt = (id: unknown, label: unknown, description?: unknown): OptionItem | null => {
  const value = str(id)
  if (!value) return null
  return { value, label: str(label) || value, description: str(description) }
}

const SIMPLE_SOURCES: Record<string, SimpleSource> = {
  // GET /api/2/connectors - https://developers.onelogin.com/api-docs/2/connectors/list-connectors
  connectors: {
    path: '/api/2/connectors',
    toOption: (c) => opt(c.id, c.name, c.auth_method_description ?? c.auth_method),
  },
  // GET /api/2/apps - https://developers.onelogin.com/api-docs/2/apps/list-apps
  apps: {
    path: '/api/2/apps',
    toOption: (a) => opt(a.id, a.name, a.auth_method_description ?? a.connector_id),
  },
  // GET /api/2/roles - https://developers.onelogin.com/api-docs/2/roles/list-roles
  roles: {
    path: '/api/2/roles',
    toOption: (r) => opt(r.id, r.name),
  },
}

const SUPPORTED_SOURCES = new Set(Object.keys(SIMPLE_SOURCES))

/**
 * Live options provider shared by every onelogin config type. Powers
 * `remote-select` / `remote-multiselect` canvas fields via
 * GET /api/apps/onelogin/config-options. The platform resolves the
 * connection and runs this in-process, so it can call the OneLogin account
 * directly with the decrypted API credential.
 *
 * Sources: connectors (for Apps' connector_id picker), apps (for Roles' app
 * assignment and App Rules' target app picker), roles (for Privileges' role
 * assignment) - each a direct `GET /api/2/<resource>` list, mapped to
 * `{ value: id, label: name }`.
 */
const oneLoginOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  if (!SUPPORTED_SOURCES.has(ctx.source)) return []

  const built = buildOneLoginClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) throw new Error(built.error)
  const { client } = built

  const items = await listSimple(client, SIMPLE_SOURCES[ctx.source])
  const query = (ctx.query ?? '').trim().toLowerCase()
  return query ? items.filter((o) => o.label.toLowerCase().includes(query)) : items
}

async function listSimple(client: OneLoginClient, spec: SimpleSource): Promise<OptionItem[]> {
  const res = await client.request('GET', spec.path, { query: { limit: OPTIONS_LIMIT } })
  if (!res.ok) {
    throw new Error(`Failed to list OneLogin options (${spec.path}): ${oneLoginErrorMessage(res)}`)
  }
  const parsed = JSON.parse(res.body || '[]') as Record<string, unknown>[]
  const rows = Array.isArray(parsed) ? parsed : []
  return rows.map(spec.toOption).filter((o): o is OptionItem => o !== null)
}

export default oneLoginOptions
