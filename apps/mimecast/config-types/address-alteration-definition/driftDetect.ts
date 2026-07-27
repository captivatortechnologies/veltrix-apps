import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMimecastClient, readMimecastSettings, resolveMimecastCredential } from '../../lib/mimecast'
import { extractAddressAlterationDefinitionSpecs } from './validate'
import { findDefinition } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildMimecastClient(cred, settings)

  const specs = extractAddressAlterationDefinitionSpecs(ctx.deployedConfig).filter((s) => s.originalAddress && s.newAddress)

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = await findDefinition(client, spec)
    if (!live) {
      diffs.push({ field: `${spec.originalAddress}->${spec.newAddress}`, expected: 'present', actual: 'absent', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
