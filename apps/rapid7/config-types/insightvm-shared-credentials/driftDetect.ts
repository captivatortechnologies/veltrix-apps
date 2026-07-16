import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listCredentials } from './deploy'
import { credentialKey, extractCredentialSpecs, type LiveCredential } from './validate'

/**
 * Detect drift between the deployed shared-credential configuration and the live
 * console. Re-finds each declared credential by name; a missing credential is
 * critical drift.
 *
 * ⚠ SECRET: only the `description` field is diffed. The secret (account.password)
 * is write-only and masked on read, so it — and the rest of the account object —
 * are NEVER read back or compared. Doing so would either leak the secret or
 * report perpetual false drift against the API's masked value.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractCredentialSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listCredentials(client)
    const byKey = new Map<string, LiveCredential>(
      live.filter((c) => c.name).map((c) => [credentialKey({ name: c.name as string }), c]),
    )

    for (const spec of specs) {
      const found = byKey.get(credentialKey(spec))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      // description ONLY — never the secret or any other account field.
      if (spec.description && (found.description ?? '') !== spec.description) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description,
          actual: found.description ?? 'not set',
          severity: 'info',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'insightvm',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
