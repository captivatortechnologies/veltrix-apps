import type { ComponentRef, CredentialRef } from '@veltrixsecops/app-sdk'
import {
  acsRequest,
  acsErrorMessage,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'

// =============================================================================
// Live options provider for the splunk-cloud config canvas. Powers
// `remote-select` / `remote-multiselect` fields via the platform's
// config-options route. The platform resolves the connection (decrypted
// credential + component) and runs this in-process, so it can call the stack's
// Admin Config Service (ACS) directly with the ACS JWT.
//
// Only ACS-backed object references are offered here — ACS is always reachable
// (admin.splunk.com) with the stack JWT the whole app already requires, so the
// pickers are reliable. Object types ACS cannot manage (roles, users) live
// behind the management-port REST API, whose availability is gated on Splunk
// Support opening port 8089 and an IP allow list, so those fields stay text.
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
  settings: Record<string, unknown>
}

export type OptionsProvider = (ctx: OptionsProviderContext) => Promise<OptionItem[]>

/** ACS caps a page with `count`; 0 means "all", which is fine for a picker. */
const ALL_RESULTS = '0'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const opt = (value: unknown, label: unknown, description?: unknown): OptionItem | null => {
  const v = str(value)
  if (!v) return null
  return { value: v, label: str(label) || v, description: str(description) || v }
}

/**
 * Declarative spec for an ACS list source: GET the collection at `path`, pull
 * the array out with `extract` (ACS returns a bare array for some resources and
 * a `{ key: [...] }` wrapper for others), and map each record to an option.
 */
interface AcsSource {
  path: string
  extract: (parsed: unknown) => Array<Record<string, unknown>>
  toOption: (row: Record<string, unknown>) => OptionItem | null
}

/** ACS `/indexes` answers with a bare array of index resources. */
function asArray(parsed: unknown): Array<Record<string, unknown>> {
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : []
}

/** ACS `/permissions/apps` answers with `{ apps: [...] }`. */
function unwrap(key: string): (parsed: unknown) => Array<Record<string, unknown>> {
  return (parsed) => {
    if (parsed && typeof parsed === 'object') {
      const arr = (parsed as Record<string, unknown>)[key]
      if (Array.isArray(arr)) return arr as Array<Record<string, unknown>>
    }
    return []
  }
}

const ACS_SOURCES: Record<string, AcsSource> = {
  indexes: {
    path: `/indexes?count=${ALL_RESULTS}`,
    extract: asArray,
    toOption: (i) => opt(i.name, i.name, i.datatype),
  },
  apps: {
    // /permissions/apps lists every app that has a permissions entry — built-in
    // premium apps included, which /apps/victoria (private uploads only) omits.
    path: `/permissions/apps?count=${ALL_RESULTS}`,
    extract: unwrap('apps'),
    toOption: (a) => opt(a.name, a.name, a.label),
  },
}

const SUPPORTED_SOURCES = new Set(Object.keys(ACS_SOURCES))

const splunkOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  if (!SUPPORTED_SOURCES.has(ctx.source)) return []

  if (!ctx.component?.hostname) {
    throw new Error(
      'No Splunk Cloud stack is registered for this connection yet — save the connection first.',
    )
  }

  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    throw new Error(
      'No ACS token available — store the Splunk Cloud JWT (sc_admin) in the credential "API token" field first.',
    )
  }

  const settings = readAcsSettings(ctx.settings)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack: resolveStackName(ctx.component.hostname),
    token,
    timeoutMs: settings.timeoutMs,
  }

  return listAcs(acs, ACS_SOURCES[ctx.source], (ctx.query ?? '').trim())
}

async function listAcs(acs: AcsRequestOptions, spec: AcsSource, query: string): Promise<OptionItem[]> {
  const res = await acsRequest(acs, 'GET', spec.path)
  if (res.status !== 200) {
    throw new Error(`Failed to list Splunk Cloud options (${spec.path}): ${acsErrorMessage(res)}`)
  }

  const rows = spec.extract(parseJson<unknown>(res.body))
  const items = rows.map(spec.toOption).filter((o): o is OptionItem => o !== null)
  const needle = query.toLowerCase()
  return needle ? items.filter((o) => o.label.toLowerCase().includes(needle)) : items
}

export default splunkOptions
