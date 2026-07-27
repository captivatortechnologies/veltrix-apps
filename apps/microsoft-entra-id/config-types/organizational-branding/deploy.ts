import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type GraphClient,
} from '../../lib/graph'
import { BRANDING_FIELDS, extractBrandingSpecs } from './validate'

/** The default-locale branding requires the Accept-Language: 0 header. */
const DEFAULT_LOCALE_HEADERS = { 'Accept-Language': '0' }

export interface RollbackEntry {
  existed: boolean
  orgId?: string
  prior?: Record<string, unknown>
}

interface LiveOrg {
  id?: string
}

/** Resolve the tenant organization id (branding lives under /organization/{id}). */
export async function resolveOrgId(client: GraphClient): Promise<string | null> {
  const res = await client.get('/organization?$select=id')
  if (!res.ok) return null
  const parsed = parseJson<{ value?: LiveOrg[] }>(res.body)
  return parsed?.value?.[0]?.id ?? null
}

/** Only the managed fields the author actually set (non-empty). */
export function buildBody(values: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const key of BRANDING_FIELDS) {
    if (values[key]) body[key] = values[key]
  }
  return body
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const spec = extractBrandingSpecs(ctx.canvas)[0]
  if (!spec) return { success: true, message: 'No organizational branding configured', rollbackData: { entries: [] } }

  const body = buildBody(spec.values)
  if (Object.keys(body).length === 0) {
    return { success: true, message: 'No branding fields set — nothing to apply', rollbackData: { entries: [] } }
  }

  const orgId = await resolveOrgId(client)
  if (!orgId) return { success: false, message: 'Could not resolve the tenant organization id from GET /organization' }
  const path = `/organization/${orgId}/branding`

  const getResp = await client.request('GET', `${path}?$select=${BRANDING_FIELDS.join(',')}`, undefined, {
    headers: DEFAULT_LOCALE_HEADERS,
  })
  const live = getResp.ok ? parseJson<Record<string, unknown>>(getResp.body) ?? {} : {}

  // Update the default branding via PATCH (Accept-Language: 0). If no default
  // branding exists yet, fall back to PUT to create it.
  let resp = await client.request('PATCH', path, body, { headers: DEFAULT_LOCALE_HEADERS })
  if (!resp.ok && resp.status === 404) {
    resp = await client.put(path, body, { headers: DEFAULT_LOCALE_HEADERS })
  }
  if (!resp.ok) {
    return { success: false, message: `Failed to update organizational branding: ${graphErrorMessage(resp)}` }
  }

  const prior: Record<string, unknown> = {}
  for (const key of Object.keys(body)) prior[key] = (live[key] as string | undefined) ?? ''

  const entries: RollbackEntry[] = [{ existed: true, orgId, prior }]
  return { success: true, message: `Updated ${Object.keys(body).length} branding field(s)`, rollbackData: { entries } }
}
