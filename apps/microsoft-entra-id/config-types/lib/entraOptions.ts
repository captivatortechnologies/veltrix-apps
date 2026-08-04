// =============================================================================
// Live options provider for the Entra ID config canvas. Powers every
// `remote-select` / `remote-multiselect` field (source = the field's
// `optionsSource`) via the platform's config-options route, which resolves the
// connection (decrypted app-registration credential + tenant id) and runs this
// in-process against Microsoft Graph.
//
// Sources -> Graph endpoint (all under https://graph.microsoft.com/v1.0):
//   groups                 GET /groups                                                  ($search: yes)
//   users                  GET /users                                                    ($search: yes)
//   applications           GET /applications            (value = appId, not id)          ($search: yes)
//   applicationObjects     GET /applications            (value = id, not appId)          ($search: yes)
//   servicePrincipals      GET /servicePrincipals        (value = id, not appId)          ($search: yes)
//   devices                GET /devices                                                  ($search: yes)
//   administrativeUnits    GET /directory/administrativeUnits                             ($search: yes)
//   namedLocations         GET /identity/conditionalAccess/namedLocations                 ($search: no)
//   roleDefinitions        GET /roleManagement/directory/roleDefinitions                  ($search: no)
//   authStrengthPolicies   GET /policies/authenticationStrengthPolicies                   ($search: no)
//   termsOfUse             GET /identityGovernance/termsOfUse/agreements                  ($search: no)
//   authContexts           GET /identity/conditionalAccess/authenticationContextClassReferences ($search: no)
//   accessPackageCatalogs  GET /identityGovernance/entitlementManagement/catalogs         ($search: no)
//   connectedOrganizations GET /identityGovernance/entitlementManagement/connectedOrganizations ($search: no)
//
// $search support is NOT uniform across Graph and was verified (not assumed)
// against "Advanced query capabilities on Microsoft Entra ID objects"
// (https://learn.microsoft.com/graph/aad-advanced-queries): only
// administrativeUnit, application, device, group, servicePrincipal and user
// are "directory objects" that support it (with the `ConsistencyLevel:
// eventual` header — $search, unlike $filter's ne/not, does NOT also need
// $count). `devices` additionally confirmed directly on GET /devices's own
// page, which documents $search on displayName with the identical
// `$search="displayName:..."` + `ConsistencyLevel: eventual` shape used here
// (https://learn.microsoft.com/graph/api/device-list). The other sources here
// are governance/policy resources, not directory objects, and do not support
// $search — confirmed per-endpoint:
// namedLocations documents $count/$filter/$orderby/$select/$skip/$top only
// (https://learn.microsoft.com/graph/api/conditionalaccessroot-list-namedlocations),
// roleDefinitions documents $filter (eq/in) on id/displayName/isBuiltIn only
// (https://learn.microsoft.com/graph/api/rbacapplication-list-roledefinitions),
// authenticationContextClassReference documents $filter (eq) only
// (https://learn.microsoft.com/graph/api/resources/authenticationcontextclassreference).
// Those sources fetch a page and filter on the label in memory instead — the
// same fallback okta-identity's provider uses for its non-searchable sources.
//
// `applications`, `applicationObjects` and `servicePrincipals` deliberately
// use DIFFERENT value spaces — three separate sources over what is, for the
// first two, the SAME Graph collection:
//   - `applications` returns the appId because that's what
//     conditionalAccessApplications.include/excludeApplications (and every
//     other "target this app" field) actually stores
//     (https://learn.microsoft.com/graph/api/resources/conditionalaccessapplications).
//   - `applicationObjects` returns the application's OBJECT id (Graph's `id`,
//     never `appId`) because that's the id space
//     unifiedRoleAssignment.directoryScopeId's app-scope pattern
//     "/{application-objectID}" requires — confirmed by the worked example on
//     the roleAssignments CREATE page ("The object ID of the application
//     registration is 661e1310-..." used directly as
//     `directoryScopeId: "/661e1310-..."`,
//     https://learn.microsoft.com/graph/api/rbacapplication-post-roleassignments).
//     Conflating this with `applications` above would silently inject an
//     appId where Graph expects an object id (and vice versa) — a wrong id
//     shape that still LOOKS valid (both are GUIDs) until the write fails, so
//     the two are kept as fully separate sources rather than one aliased pair.
//   - `servicePrincipals` returns the object id because that's what the OTHER
//     Graph relationships this app manages key on instead — appRoleAssignments,
//     oauth2PermissionGrants, roleAssignment principalIds, etc.
// Only `applications` gets the cloud-app sentinels below; prepending them to
// `servicePrincipals` or `applicationObjects` would inject appId-shaped
// literals into an object-id-keyed field.
// =============================================================================

import type { OptionItem, OptionsProvider } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type GraphClient,
} from '../../lib/graph'

/** Cap a plain listing (no query) — a searchable field never needs the whole tenant. */
const OPTIONS_LIMIT = 200
/** Cap a $search / in-memory-filtered result. */
const SEARCH_LIMIT = 50
/** getAll page budget for the plain-listing path: 2 pages covers OPTIONS_LIMIT
 *  at Graph's common ~100-per-page default without depending on $top support,
 *  which several of the non-directory-object endpoints here don't document. */
const LIST_MAX_PAGES = 2

type Row = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** Build an OptionItem, dropping the `description` key entirely when absent
 *  (rather than setting it to `undefined`) so callers get a clean object. */
function opt(value: unknown, label: unknown, description?: unknown): OptionItem | null {
  const v = str(value)
  if (!v) return null
  const item: OptionItem = { value: v, label: str(label) || v }
  const d = str(description)
  if (d) item.description = d
  return item
}

/** Narrow a fixed or already-fetched option list by a query on its label. */
function filterByLabel(items: OptionItem[], query: string): OptionItem[] {
  const needle = query.trim().toLowerCase()
  return needle ? items.filter((o) => o.label.toLowerCase().includes(needle)) : items
}

function userOption(u: Row): OptionItem | null {
  const id = str(u.id)
  if (!id) return null
  const upn = str(u.userPrincipalName)
  const display = str(u.displayName)
  const label = display && upn ? `${display} (${upn})` : display || upn || id
  return { value: id, label, ...(upn ? { description: upn } : {}) }
}

/** authenticationContextClassReference ids are the opaque cN token itself
 *  (Graph docs: "c1" through "c25"; the newer Entra admin-center UX has since
 *  raised the cap to c99 without the API reference page catching up yet — see
 *  the report for this discrepancy) — surface it in the label since it's the
 *  value an app developer/PIM policy actually references. */
function authContextOption(c: Row): OptionItem | null {
  const id = str(c.id)
  if (!id) return null
  const name = str(c.displayName)
  const label = name ? `${name} (${id})` : id
  const description = str(c.description) || (c.isAvailable === false ? 'Not yet published' : undefined)
  return { value: id, label, ...(description ? { description } : {}) }
}

function namedLocationOption(n: Row): OptionItem | null {
  const type = str(n['@odata.type'])
  const kind = type?.endsWith('ipNamedLocation')
    ? 'IP range'
    : type?.endsWith('countryNamedLocation')
      ? 'Country/region'
      : undefined
  return opt(n.id, n.displayName, kind)
}

/**
 * Declarative spec for a source backed by a single Graph collection endpoint.
 * `searchable` gates whether a query is sent as Graph `$search` (server-side)
 * or filtered on the label afterwards (client-side) — see the module header
 * for which sources verified as which.
 */
interface SimpleSource {
  /** Path relative to the Graph v1.0 base, no query string — e.g. '/groups'. */
  path: string
  /** Comma-joined $select fields (kept unencoded like the rest of this app's Graph calls). */
  select: string
  searchable: boolean
  toOption: (raw: Row) => OptionItem | null
}

const SIMPLE_SOURCES: Record<string, SimpleSource> = {
  groups: {
    path: '/groups',
    select: 'id,displayName',
    searchable: true,
    toOption: (g) => opt(g.id, g.displayName, g.id),
  },
  users: {
    path: '/users',
    select: 'id,displayName,userPrincipalName',
    searchable: true,
    toOption: userOption,
  },
  applications: {
    path: '/applications',
    select: 'id,appId,displayName',
    searchable: true,
    // value = appId: conditionalAccessApplications.include/excludeApplications
    // (and app-targeting fields generally) store the appId, not the object id.
    toOption: (a) => opt(a.appId, a.displayName, a.id),
  },
  applicationObjects: {
    path: '/applications',
    select: 'id,appId,displayName',
    searchable: true,
    // value = the application's OBJECT id (Graph's `id`), NOT appId — see the
    // module header for why this is a separate source from `applications`.
    toOption: (a) => opt(a.id, a.displayName, a.appId),
  },
  servicePrincipals: {
    path: '/servicePrincipals',
    select: 'id,appId,displayName',
    searchable: true,
    // value = object id: appRoleAssignments / oauth2PermissionGrants / role
    // assignment principalIds all key on the SP's id, not its appId.
    toOption: (s) => opt(s.id, s.displayName, s.appId),
  },
  devices: {
    path: '/devices',
    select: 'id,displayName',
    searchable: true,
    toOption: (d) => opt(d.id, d.displayName, d.id),
  },
  administrativeUnits: {
    path: '/directory/administrativeUnits',
    select: 'id,displayName,description',
    searchable: true,
    toOption: (a) => opt(a.id, a.displayName, a.description ?? a.id),
  },
  namedLocations: {
    path: '/identity/conditionalAccess/namedLocations',
    select: 'id,displayName',
    searchable: false,
    toOption: namedLocationOption,
  },
  roleDefinitions: {
    path: '/roleManagement/directory/roleDefinitions',
    select: 'id,displayName,description,isBuiltIn',
    searchable: false,
    toOption: (r) => opt(r.id, r.displayName, r.description ?? (r.isBuiltIn ? 'Built-in role' : 'Custom role')),
  },
  authStrengthPolicies: {
    path: '/policies/authenticationStrengthPolicies',
    select: 'id,displayName,description,policyType',
    searchable: false,
    toOption: (p) => opt(p.id, p.displayName, p.description ?? p.policyType),
  },
  termsOfUse: {
    path: '/identityGovernance/termsOfUse/agreements',
    select: 'id,displayName',
    searchable: false,
    toOption: (t) => opt(t.id, t.displayName, t.id),
  },
  authContexts: {
    path: '/identity/conditionalAccess/authenticationContextClassReferences',
    select: 'id,displayName,description,isAvailable',
    searchable: false,
    toOption: authContextOption,
  },
  accessPackageCatalogs: {
    path: '/identityGovernance/entitlementManagement/catalogs',
    select: 'id,displayName,description',
    searchable: false,
    toOption: (c) => opt(c.id, c.displayName, c.description ?? c.id),
  },
  connectedOrganizations: {
    path: '/identityGovernance/entitlementManagement/connectedOrganizations',
    select: 'id,displayName,description,state',
    searchable: false,
    toOption: (c) => opt(c.id, c.displayName, c.description ?? c.state),
  },
}

/**
 * Well-known literal values Graph accepts directly in
 * conditionalAccessApplications.include/excludeApplications, alongside real
 * appIds (https://learn.microsoft.com/graph/api/resources/conditionalaccessapplications).
 *
 * NOTE: the Phase-1 plan additionally called for a "None" sentinel, but no
 * such literal is documented on this resource — only `All`, `Office365` and
 * `MicrosoftAdminPortals` are. Offering an unsupported value in a live picker
 * would look valid and then fail the policy PATCH/POST at deploy time, so
 * "None" is intentionally NOT included here. See the phase report for detail.
 */
const CLOUD_APP_SENTINELS: OptionItem[] = [
  { value: 'All', label: 'All cloud apps (All)', description: 'Every cloud app registered in the tenant' },
  {
    value: 'Office365',
    label: 'Office 365 (Office365)',
    description: 'The Microsoft 365 app suite (Exchange, SharePoint, Teams, ...)',
  },
  {
    value: 'MicrosoftAdminPortals',
    label: 'Microsoft Admin Portals (MicrosoftAdminPortals)',
    description: 'Azure portal, Microsoft 365 admin center, Exchange admin center, Security & Compliance Center',
  },
]

/** Quote-and-escape a query for Graph's `$search="displayName:term"` syntax. */
function searchExpression(term: string): string {
  return `"displayName:${term.replace(/"/g, '\\"')}"`
}

/**
 * Fetch options for one declarative source. Searchable sources with a query
 * use server-side `$search` (requires `ConsistencyLevel: eventual`, capped at
 * SEARCH_LIMIT); everything else lists a page via the paginating `getAll` (so
 * this never depends on $top support, which isn't documented for several of
 * these endpoints) and — when a query was given — narrows it on the label.
 */
async function listSimple(client: GraphClient, spec: SimpleSource, query: string): Promise<OptionItem[]> {
  if (spec.searchable && query) {
    const path = `${spec.path}?$select=${spec.select}&$search=${encodeURIComponent(searchExpression(query))}`
    const res = await client.request('GET', path, undefined, { headers: { ConsistencyLevel: 'eventual' } })
    if (!res.ok) {
      throw new Error(`Failed to search Entra ${spec.path}: ${graphErrorMessage(res)}`)
    }
    const rows = parseJson<{ value?: Row[] }>(res.body)?.value ?? []
    return rows
      .map(spec.toOption)
      .filter((o): o is OptionItem => o !== null)
      .slice(0, SEARCH_LIMIT)
  }

  const listed = await client.getAll<Row>(`${spec.path}?$select=${spec.select}`, LIST_MAX_PAGES)
  if (!listed.ok) {
    throw new Error(`Failed to list Entra ${spec.path}: ${graphErrorMessage(listed.lastError!)}`)
  }
  const items = listed.items
    .map(spec.toOption)
    .filter((o): o is OptionItem => o !== null)
    .slice(0, OPTIONS_LIMIT)
  return query ? filterByLabel(items, query) : items
}

/**
 * Live options provider for the microsoft-entra-id config canvas. See the
 * module header for the full source -> Graph endpoint table.
 */
const entraOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  const spec = SIMPLE_SOURCES[ctx.source]
  if (!spec) return []

  const settings = readGraphSettings(ctx.settings ?? {})
  const cred = resolveGraphCredential(ctx.credential ?? null, settings)
  if (!cred) {
    throw new Error(MISSING_CREDENTIAL_MESSAGE)
  }
  const client = buildGraphClient(cred, settings)
  const query = (ctx.query ?? '').trim()

  const items = await listSimple(client, spec, query)
  if (ctx.source === 'applications') {
    return [...filterByLabel(CLOUD_APP_SENTINELS, query), ...items]
  }
  return items
}

export default entraOptions
