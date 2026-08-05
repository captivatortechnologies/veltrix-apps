import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractB2xUserFlowSpecs, resultingId, type LiveB2xUserFlow } from './validate'
import { buildIdNameMap, resolveByIdOrNameMany } from '../lib/nameMaps'
import { listRefIds } from '../lib/refReconcile'
import { buildAttributeMaps } from './deploy'

const BASE = '/identity/b2xUserFlows'

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractB2xUserFlowSpecs(ctx.deployedConfig).filter((s) => s.id)
  const listed = await client.getAll<LiveB2xUserFlow>(`${BASE}?$select=id`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveIds = new Set(listed.items.filter((f) => f.id).map((f) => f.id!.toLowerCase()))
  const identityProviderMap = await buildIdNameMap(client, '/identity/identityProviders?$select=id,displayName')
  const attributeMaps = await buildAttributeMaps(client)

  const diffs: DriftResult['diffs'] = []
  for (const spec of specs) {
    const id = resultingId(spec.id)
    if (!liveIds.has(id.toLowerCase())) {
      diffs.push({ field: id, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    const idpResolution = resolveByIdOrNameMany(spec.identityProviders, identityProviderMap)
    if (idpResolution.missing.length) {
      diffs.push({
        field: `${id}.identityProviders`,
        expected: 'resolvable',
        actual: `unknown identity provider(s): ${idpResolution.missing.join(', ')}`,
        severity: 'critical',
      })
    } else {
      const liveIdps = await listRefIds(client, `${BASE}/${id}`, 'identityProviders')
      if (liveIdps.ok) {
        const missingLive = idpResolution.ids.filter((i) => !liveIdps.ids.has(i))
        if (missingLive.length) {
          diffs.push({
            field: `${id}.identityProviders`,
            expected: sortedJson(idpResolution.ids),
            actual: sortedJson([...liveIdps.ids]),
            severity: 'warning',
          })
        }
      }
    }

    const attrResolution = resolveByIdOrNameMany(spec.attributes, attributeMaps)
    if (attrResolution.missing.length) {
      diffs.push({
        field: `${id}.attributes`,
        expected: 'resolvable',
        actual: `unknown attribute(s): ${attrResolution.missing.join(', ')}`,
        severity: 'critical',
      })
    } else {
      const liveAttrs = await listRefIds(client, `${BASE}/${id}`, 'userAttributeAssignments')
      if (liveAttrs.ok) {
        const missingLive = attrResolution.ids.filter((i) => !liveAttrs.ids.has(i))
        if (missingLive.length) {
          diffs.push({
            field: `${id}.attributes`,
            expected: sortedJson(attrResolution.ids),
            actual: sortedJson([...liveAttrs.ids]),
            severity: 'warning',
          })
        }
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
