import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, withSession } from '../../lib/beyondtrustApi'
import { findAttributeByShortName, findAttributeTypeByName, listFrom, str, type Attribute, type AttributeType } from './_shared'

/**
 * Drift for attributes: compare what we declare against the live value in
 * Password Safe, scoped to the resolved attribute type. A declared attribute
 * type or value that is MISSING is a warning; a present value whose long name
 * / description differ is info (no update endpoint is documented, so these can
 * only be corrected by delete + recreate). Best-effort and read-only:
 * GET /AttributeTypes and GET /AttributeTypes/{id}/Attributes inside a
 * PS-Auth session. Verify against a live BeyondTrust instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)

  let types: AttributeType[]
  try {
    types = await withSession(base, credential, async (cookie) =>
      listFrom<AttributeType>(await getJson<unknown>(base, '/AttributeTypes', cookie)),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read types, no drift asserted
  }

  const attributesByType = new Map<string, Attribute[]>()

  for (const item of items) {
    const attributeTypeName = str(item.fields.attributeTypeName)
    const shortName = str(item.fields.shortName)
    if (!attributeTypeName || !shortName) continue

    const label = `${attributeTypeName}/${shortName}`
    const type = findAttributeTypeByName(types, attributeTypeName)
    if (!type?.AttributeTypeID) {
      diffs.push({ field: label, expected: 'present', actual: 'attribute type missing', severity: 'warning' })
      continue
    }

    const typeKey = String(type.AttributeTypeID)
    let liveAttributes = attributesByType.get(typeKey)
    if (!liveAttributes) {
      try {
        liveAttributes = await withSession(base, credential, async (cookie) =>
          listFrom<Attribute>(await getJson<unknown>(base, `/AttributeTypes/${encodeURIComponent(typeKey)}/Attributes`, cookie)),
        )
      } catch {
        continue // best-effort: can't read this type's attributes, don't assert drift for it
      }
      attributesByType.set(typeKey, liveAttributes)
    }

    const match = findAttributeByShortName(liveAttributes, shortName)
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const desiredLongName = str(item.fields.longName)
    if (desiredLongName && str(match.LongName) !== desiredLongName) {
      diffs.push({ field: `${label}.longName`, expected: desiredLongName, actual: match.LongName ?? '', severity: 'info' })
    }

    const desiredDescription = str(item.fields.description)
    if (desiredDescription && str(match.Description) !== desiredDescription) {
      diffs.push({ field: `${label}.description`, expected: desiredDescription, actual: match.Description ?? '', severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
