import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, parseJson, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { BRANDING_FIELDS, extractBrandingSpecs } from './validate'
import { resolveOrgId } from './deploy'

const DEFAULT_LOCALE_HEADERS = { 'Accept-Language': '0' }

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const spec = extractBrandingSpecs(ctx.deployedConfig)[0]
  if (!spec) return { hasDrift: false, diffs: [] }

  const orgId = await resolveOrgId(client)
  if (!orgId) return { hasDrift: false, diffs: [] }

  const resp = await client.request(
    'GET',
    `/organization/${orgId}/branding?$select=${BRANDING_FIELDS.join(',')}`,
    undefined,
    { headers: DEFAULT_LOCALE_HEADERS },
  )
  if (!resp.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<Record<string, unknown>>(resp.body) ?? {}

  const diffs: DriftResult['diffs'] = []
  for (const key of BRANDING_FIELDS) {
    const want = spec.values[key]
    if (!want) continue // unmanaged field
    const actual = (live[key] as string | undefined) ?? ''
    if (want !== actual) {
      diffs.push({ field: key, expected: want, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
