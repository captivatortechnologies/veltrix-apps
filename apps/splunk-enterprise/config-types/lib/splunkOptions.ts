import type { ComponentRef, CredentialRef } from '@veltrixsecops/app-sdk'
import { buildAuthHeader, buildSplunkUrl, getJson } from '../../lib/splunkApi'

// =============================================================================
// Live options provider for the splunk-enterprise config canvas. Powers
// `remote-select` / `remote-multiselect` fields via the platform's
// config-options route. The platform resolves the connection (decrypted
// credential + component) and runs this in-process, so it can call splunkd's
// management API directly.
//
// The OptionItem / OptionsProviderContext contract is declared locally: the
// platform passes a context object and consumes the returned OptionItem[]
// structurally, and the SDK build installed here predates those type exports.
// The shapes mirror @veltrixsecops/app-sdk's pipeline types exactly.
// =============================================================================

/** One selectable option returned to a live picker. */
export interface OptionItem {
  value: string
  label: string
  description?: string
}

/** Context the platform passes to a live options provider. */
export interface OptionsProviderContext {
  appId: string
  customerId: string
  configTypeId: string
  source: string
  query?: string
  component: ComponentRef | null
  credential: CredentialRef | null
  /** The component's connectivity provider — carries the managed-ZTNA tailnet address. */
  connectivityProvider?: { config?: Record<string, unknown> | null } | null
  settings: Record<string, unknown>
}

export type OptionsProvider = (ctx: OptionsProviderContext) => Promise<OptionItem[]>

const DEFAULT_MANAGEMENT_PORT = '8089'
/** Cap the picker's live fetch — a searchable field never needs the whole instance. */
const OPTIONS_LIMIT = 1000
const REQUEST_TIMEOUT_MS = 15_000

/** A single Splunk REST collection entry: `{ name, content }`. */
interface SplunkEntry {
  name?: string
  content?: Record<string, unknown>
}

interface SplunkCollectionResponse {
  entry?: SplunkEntry[]
}

/**
 * Declarative spec for a "simple list" source: GET a Splunk REST collection at
 * `path`, then map each entry to an option. Keeps every single-object picker to
 * one line of config.
 */
interface SimpleSource {
  path: string
  extraQuery?: Record<string, string>
  toOption: (entry: SplunkEntry) => OptionItem | null
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const opt = (value: unknown, label: unknown, description?: unknown): OptionItem | null => {
  const v = str(value)
  if (!v) return null
  return { value: v, label: str(label) || v, description: str(description) || v }
}

/** A readable descriptor for an index option: datatype and disabled state. */
function indexDescription(content: Record<string, unknown> | undefined): string | undefined {
  if (!content) return undefined
  const parts: string[] = []
  const datatype = str(content.datatype)
  if (datatype) parts.push(datatype)
  if (content.disabled === true || content.disabled === '1' || content.disabled === 1) parts.push('disabled')
  return parts.length > 0 ? parts.join(' · ') : undefined
}

const SIMPLE_SOURCES: Record<string, SimpleSource> = {
  indexes: {
    path: '/services/data/indexes',
    // datatype=all includes metric indexes alongside event indexes.
    extraQuery: { datatype: 'all' },
    toOption: (e) => opt(e.name, e.name, indexDescription(e.content)),
  },
}

/** Sources this provider knows how to resolve. */
const SUPPORTED_SOURCES = new Set(Object.keys(SIMPLE_SOURCES))


const splunkOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  if (!SUPPORTED_SOURCES.has(ctx.source)) return []

  if (!ctx.component?.hostname) {
    throw new Error(
      'No Splunk deploy target is registered for this connection yet — save the connection first.',
    )
  }
  if (!ctx.credential) {
    throw new Error(
      'No Splunk credential available — store an API token or username/password on the connection first.',
    )
  }

  // Prefer the managed-ZTNA tailnet address (buildSplunkUrl) — a raw `.local`
  // hostname never resolves from the platform (getaddrinfo EAI_AGAIN).
  const baseUrl = buildSplunkUrl(ctx.component, null, ctx.connectivityProvider)
  const auth = buildAuthHeader(ctx.credential)
  const query = (ctx.query ?? '').trim()

  return listSimple(baseUrl, auth, SIMPLE_SOURCES[ctx.source], query)
}

async function listSimple(
  baseUrl: string,
  auth: Record<string, string>,
  spec: SimpleSource,
  query: string,
): Promise<OptionItem[]> {
  const params = new URLSearchParams({ count: String(OPTIONS_LIMIT) })
  for (const [k, v] of Object.entries(spec.extraQuery ?? {})) params.set(k, v)

  let data: SplunkCollectionResponse
  try {
    data = await getJson<SplunkCollectionResponse>(baseUrl, auth, `${spec.path}?${params.toString()}`, REQUEST_TIMEOUT_MS)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to list Splunk options (${spec.path}): ${message}`)
  }

  const items = (data.entry ?? []).map(spec.toOption).filter((o): o is OptionItem => o !== null)
  const needle = query.toLowerCase()
  return needle ? items.filter((o) => o.label.toLowerCase().includes(needle)) : items
}

export default splunkOptions
