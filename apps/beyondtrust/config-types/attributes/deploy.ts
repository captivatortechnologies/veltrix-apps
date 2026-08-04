import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, sendJson, withSession } from '../../lib/beyondtrustApi'
import {
  buildAttributeBody,
  findAttributeByShortName,
  findAttributeTypeByName,
  listFrom,
  str,
  type Attribute,
  type AttributeType,
} from './_shared'

/**
 * Deploy Password Safe attributes over the BeyondInsight REST API inside a
 * PS-Auth session, in two tiers:
 *   type (category):  GET /AttributeTypes                              → match by name
 *                      POST /AttributeTypes { Name }                    create if absent
 *   value:            GET /AttributeTypes/{typeId}/Attributes           → match by ShortName
 *                      POST /AttributeTypes/{typeId}/Attributes         create if absent
 *
 * Both tiers are create-if-absent (no update endpoint is documented for
 * either). rollbackData records, per item, the resolved type id and whether WE
 * created the TYPE (never deleted by rollback — it's shared and DELETE
 * /AttributeTypes/{id} cascades) and whether WE created the VALUE (which
 * rollback DOES delete).
 *
 * NOTE: verify /AttributeTypes create + /AttributeTypes/{id}/Attributes create
 * against a live BeyondTrust instance.
 */
interface RollbackEntry {
  attributeTypeName: string
  attributeTypeId: number | string | null
  typeCreated: boolean
  shortName: string
  attributeId: number | string | null
  action: 'created' | 'existing'
}

async function listAttributeTypes(base: string, cookie: string): Promise<AttributeType[]> {
  try {
    return listFrom<AttributeType>(await getJson<unknown>(base, '/AttributeTypes', cookie))
  } catch {
    return []
  }
}

async function listAttributes(base: string, cookie: string, typeId: number | string): Promise<Attribute[]> {
  try {
    return listFrom<Attribute>(await getJson<unknown>(base, `/AttributeTypes/${encodeURIComponent(String(typeId))}/Attributes`, cookie))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for attribute deployment' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  const previous: RollbackEntry[] = []
  const typesCreated: string[] = []
  const created: string[] = []
  const existing: string[] = []

  try {
    await withSession(base, credential, async (cookie) => {
      let types = await listAttributeTypes(base, cookie)

      for (const item of items) {
        const attributeTypeName = str(item.fields.attributeTypeName)
        const shortName = str(item.fields.shortName)
        if (!attributeTypeName || !shortName) continue

        let type = findAttributeTypeByName(types, attributeTypeName)
        let typeCreated = false
        if (!type) {
          type = await sendJson<AttributeType>('POST', base, '/AttributeTypes', cookie, { Name: attributeTypeName })
          typeCreated = true
          types = [...types, type]
          typesCreated.push(attributeTypeName)
        }
        const typeId = type?.AttributeTypeID
        if (typeId == null) {
          throw new Error(`Attribute type "${attributeTypeName}" has no id after create/lookup.`)
        }

        const label = `${attributeTypeName}/${shortName}`
        const liveAttributes = await listAttributes(base, cookie, typeId)
        const match = findAttributeByShortName(liveAttributes, shortName)

        if (match?.AttributeID != null) {
          existing.push(label)
          previous.push({ attributeTypeName, attributeTypeId: typeId, typeCreated, shortName, attributeId: match.AttributeID, action: 'existing' })
          continue
        }

        const body = buildAttributeBody(item.fields)
        const res = await sendJson<Attribute>('POST', base, `/AttributeTypes/${encodeURIComponent(String(typeId))}/Attributes`, cookie, body)
        created.push(label)
        previous.push({ attributeTypeName, attributeTypeId: typeId, typeCreated, shortName, attributeId: res?.AttributeID ?? null, action: 'created' })
      }
    })

    const parts: string[] = []
    if (typesCreated.length) parts.push(`${typesCreated.length} attribute type(s) created`)
    if (created.length) parts.push(`${created.length} attribute(s) created`)
    if (existing.length) parts.push(`${existing.length} already present`)
    return {
      success: true,
      message: `Attributes: ${parts.join(', ') || '(none)'}`,
      artifacts: { typesCreated, created, existing },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Attribute deploy failed after ${created.length} created: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { typesCreated, created, existing },
      rollbackData: { previous },
    }
  }
}
