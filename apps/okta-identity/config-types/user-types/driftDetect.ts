import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findUserTypeByName, listUserTypes } from './deploy'
import { extractUserTypeSpecs } from './validate'

/**
 * Detect drift between the deployed user-type configuration and the live Okta
 * org. Each declared type is re-found by name and its editable fields compared:
 *   - displayName
 *   - description
 *
 * `name` is the immutable identity (used to match) so it can never read as drift.
 * Server-managed readOnly fields (id, default, created, lastUpdated, _links) are
 * never modeled so they cannot read as drift either.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractUserTypeSpecs(ctx.deployedConfig).filter((s) => s.name && s.displayName)

  let liveTypes
  try {
    liveTypes = await listUserTypes(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'user-types',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  for (const spec of specs) {
    const live = findUserTypeByName(liveTypes, spec.name)

    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveDisplay = (live.displayName ?? '').toString()
    if (spec.displayName !== liveDisplay) {
      diffs.push({
        field: `${spec.name}.displayName`,
        expected: spec.displayName,
        actual: liveDisplay || 'not set',
        severity: 'warning',
      })
    }

    const liveDescription = (live.description ?? '').toString()
    const desiredDescription = spec.description ?? ''
    if (desiredDescription !== liveDescription) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: desiredDescription || 'not set',
        actual: liveDescription || 'not set',
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
