/** A partial listing cannot prove absence; duplicate target names cannot select an identity. */
export function reconciliationIssue(
  listed: { ok: boolean; truncated: boolean; items: unknown[] },
  declaredNames: string[],
): string | null {
  if (!listed.ok) return null // The caller preserves the vendor's diagnostic.
  if (listed.truncated) return 'Cannot safely reconcile a truncated listing. Inspect live state before retrying.'
  const requested = new Set(declaredNames.filter(Boolean).map(n => n.toLowerCase()))
  const seen = new Map<string, unknown>()
  for (const item of listed.items) {
    if (!item || typeof item !== 'object') continue
    const row = item as { displayName?: string; id?: string }
    if (!row.displayName || !requested.has(row.displayName.toLowerCase())) continue
    const name = row.displayName.toLowerCase()
    if (seen.has(name) && seen.get(name) !== row.id) return `Ambiguous resource name: ${row.displayName}. Resolve duplicate names before deployment.`
    seen.set(name, row.id)
  }
  return null
}
