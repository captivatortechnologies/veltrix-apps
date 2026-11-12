import type { GraphClient } from '../../lib/graph'

export type LookupStatus = 'resolved' | 'missing' | 'ambiguous' | 'failed' | 'incomplete'
export class CheckedNameMap extends Map<string, string> {
  readonly ambiguous = new Set<string>()
  issue: 'failed' | 'incomplete' | undefined
  override set(key: string, value: string): this {
    const existing = super.get(key)
    if (this.ambiguous.has(key) || (existing && existing !== value)) {
      this.ambiguous.add(key)
      super.delete(key)
      return this
    }
    return super.set(key, value)
  }
  override get(key: string): string | undefined {
    return this.issue || this.ambiguous.has(key) ? undefined : super.get(key)
  }
}

export function lookupName(map: Map<string, string>, value: string): { status: LookupStatus; id?: string } {
  const key = value.trim().toLowerCase()
  if (map instanceof CheckedNameMap) {
    if (map.issue) return { status: map.issue }
    if (map.ambiguous.has(key)) return { status: 'ambiguous' }
  }
  const id = map.get(key)
  return id ? { status: 'resolved', id } : { status: 'missing' }
}

export function describeLookup(map: Map<string, string>, value: string): string {
  const result = lookupName(map, value)
  return result.status === 'missing' || result.status === 'resolved' ? value
    : `${value} (${result.status} lookup; select an explicit ID or repair read access)`
}

/** Failed and capped listings remain distinct from a proven empty collection. */
export async function buildNameMap(client: GraphClient, path: string, userAliases = false): Promise<CheckedNameMap> {
  const map = new CheckedNameMap()
  const listed = await client.getAll<{ id?: string; displayName?: string; userPrincipalName?: string }>(path)
  if (!listed.ok) map.issue = 'failed'
  else if (listed.truncated) map.issue = 'incomplete'
  else for (const item of listed.items) {
    if (!item.id) continue
    if (item.displayName) map.set(item.displayName.toLowerCase(), item.id)
    if (userAliases && item.userPrincipalName) map.set(item.userPrincipalName.toLowerCase(), item.id)
  }
  return map
}
