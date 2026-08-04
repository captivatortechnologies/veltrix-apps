// =============================================================================
// subjectSet wrapper builders for the entitlement-management config types.
//
// subjectSet is Graph's abstract base for "who" in entitlement management
// request/approval/review settings (https://learn.microsoft.com/graph/api/resources/subjectset).
// This app only ever needs to WRITE four of its derived kinds, each confirmed
// on its own resource page:
//   singleUser                   { userId, description }              (https://learn.microsoft.com/graph/api/resources/singleuser)
//   groupMembers                  { groupId, description }             (https://learn.microsoft.com/graph/api/resources/groupmembers)
//   singleServicePrincipal        { servicePrincipalId, description }  (https://learn.microsoft.com/graph/api/resources/singleserviceprincipal)
//   connectedOrganizationMembers  { connectedOrganizationId, description } (https://learn.microsoft.com/graph/api/resources/connectedorganizationmembers)
// `description` is documented read-only on every one of the four ("The name of
// the user/group in Microsoft Entra ID. Read-only.") — Graph fills it in on
// read, so it is never sent on write; the builders below omit it.
//
// Every field this app exposes that produces one of these kinds is a SINGLE
// live picker over a SINGLE Graph collection (e.g. "onBehalfRequestorUsers" is
// users-only, "onBehalfRequestorGroups" is groups-only) rather than one merged
// "directoryPrincipals"-style alias across kinds. That is a deliberate
// departure from ../lib/principals.ts's merged picker: a flat id field (e.g.
// unifiedRoleAssignment.principalId) is the SAME shape regardless of kind, so
// principals.ts can merge users/groups/servicePrincipals into one field and
// let Graph resolve the kind server-side. A subjectSet entry is NOT the same
// shape per kind — it needs the right @odata.type AND a differently-named id
// property (userId vs groupId vs servicePrincipalId vs connectedOrganizationId)
// — and this app's remote-multiselect fields store a bare array of Graph ids
// with no room to also carry back "which kind was this option". Rather than
// invent a composite "kind:id" stored value (a pattern no other picker in this
// app uses, and one a hand-typed pre-picker value could never produce), each
// subjectSet-producing field is kept single-kind so the id -> subjectSet
// mapping below never needs to guess.
// =============================================================================

export function singleUser(id: string): Record<string, unknown> {
  return { '@odata.type': '#microsoft.graph.singleUser', userId: id }
}

export function groupMembers(id: string): Record<string, unknown> {
  return { '@odata.type': '#microsoft.graph.groupMembers', groupId: id }
}

export function singleServicePrincipal(id: string): Record<string, unknown> {
  return { '@odata.type': '#microsoft.graph.singleServicePrincipal', servicePrincipalId: id }
}

export function connectedOrganizationMembers(id: string): Record<string, unknown> {
  return { '@odata.type': '#microsoft.graph.connectedOrganizationMembers', connectedOrganizationId: id }
}

/** Map a batch of resolved ids of ONE kind to their subjectSet entries. */
export function manyOf(ids: string[], toSubject: (id: string) => Record<string, unknown>): Record<string, unknown>[] {
  return ids.map(toSubject)
}
