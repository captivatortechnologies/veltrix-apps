import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractIdentityProviderSpecs, type LiveIdentityProvider } from './validate'

const BASE = '/identity/identityProviders'
const SELECT = '?$select=id,displayName,identityProviderType,clientId'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractIdentityProviderSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveIdentityProvider>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((p) => p.displayName).map((p) => [p.displayName!.toLowerCase(), p]),
  )

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    // clientSecret is write-only and cannot be compared.
    if (spec.clientId && spec.clientId !== (live.clientId ?? '')) {
      diffs.push({ field: `${spec.name}.clientId`, expected: spec.clientId, actual: live.clientId ?? '', severity: 'warning' })
    }
    if (spec.identityProviderType && live.identityProviderType && spec.identityProviderType !== live.identityProviderType) {
      diffs.push({
        field: `${spec.name}.identityProviderType`,
        expected: spec.identityProviderType,
        actual: live.identityProviderType,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
