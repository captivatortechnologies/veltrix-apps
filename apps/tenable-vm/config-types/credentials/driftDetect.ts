import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { findCredentialByName } from './deploy'
import { extractCredentialSpecs } from './validate'

/**
 * Detect drift between the deployed credential configuration and the live
 * tenant state. Re-finds each declared credential by `name` and diffs the
 * managed NON-SECRET fields.
 *
 * SECRET-BEARING — READ THIS BEFORE ADDING A FIELD:
 * A Tenable credential's per-type `settings` object holds WRITE-ONLY secrets
 * (passwords, private keys, secret keys). The API NEVER returns them on GET, so
 * there is nothing to compare against — any "diff" of settings would compare the
 * canvas value to `undefined` and always report false drift. Therefore this
 * handler diffs ONLY `description` and `type` (name is the identity we match on)
 * and MUST NEVER diff `settings` / secret fields. Do not add settings here.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractCredentialSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)

  for (const spec of specs) {
    const label = spec.name
    try {
      // Matched by name — the logical identity. A renamed live credential reads
      // as "missing" here (same as any other config type keyed on its identity).
      const live = await findCredentialByName(client, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // type — the credential-type slug (non-secret, returned on read).
      const liveType = (typeof live.type === 'string' ? live.type : '').trim()
      if (spec.type !== liveType) {
        diffs.push({
          field: `${label}.type`,
          expected: spec.type,
          actual: liveType || 'not set',
          severity: 'critical',
        })
      }

      // description — non-secret, returned on read.
      const liveDescription = (typeof live.description === 'string' ? live.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${label}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      // settings / secrets: DELIBERATELY NOT DIFFED. They are write-only and
      // never returned by the API, so they cannot be compared. See the file
      // header — do not add them.
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
