import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, verifyTls } from '../../lib/axoniusApi'
import { labelsResource, tagNamesFromResponse, tagExists, normalizeEntity, parseText, type TagEntity } from './_shared'

/**
 * Drift for tags: confirm each declared label still exists in its asset module.
 * The labels endpoint returns the module's label names, so we assert presence — a
 * label that has been deleted (no asset carries it) surfaces as drift. Best-effort:
 * a transient read error raises no false drift. Read-only: GET api/<module>/labels.
 *
 * FLAG: this is presence-level drift only. Membership drift (an asset that now
 * matches the filter but is untagged, or vice-versa) needs per-asset counting and
 * is out of scope here.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) return { hasDrift: false, diffs }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)
  const labelCache = new Map<TagEntity, string[] | null>()

  for (const item of items) {
    const label = parseText(item.fields.name)
    if (!label) continue
    const entity = normalizeEntity(item.fields.entity)

    if (!labelCache.has(entity)) {
      try {
        labelCache.set(
          entity,
          tagNamesFromResponse(
            await getJson<unknown>(apiUrl(base, settings, labelsResource(entity)), headers, { verifyTls: verifyTls(settings) }),
          ),
        )
      } catch {
        labelCache.set(entity, null) // best-effort: can't read labels for this module
      }
    }

    const names = labelCache.get(entity)
    if (names === null || names === undefined) continue
    if (!tagExists(names, label)) {
      diffs.push({ field: `${entity}/${label}.exists`, expected: true, actual: false, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
