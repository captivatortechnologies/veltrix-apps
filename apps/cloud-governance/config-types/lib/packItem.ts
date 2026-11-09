import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { PolicyPack } from '../../lib/model/types'
import { readList, readOptionalString, readString } from './readers'

export function readPackItem(item: CanvasItemSnapshot): Record<string, unknown> {
  const fields = item.fields ?? {}
  const pack: Record<string, unknown> = { name: readString(fields, 'name'), policies: readList(fields, 'policies') }
  const description = readOptionalString(fields, 'description')
  if (description !== undefined) pack.description = description
  return pack
}

export function packsOf(items: readonly CanvasItemSnapshot[]): PolicyPack[] {
  return items.map((item) => readPackItem(item) as unknown as PolicyPack).filter((pack) => pack.name !== '')
}
