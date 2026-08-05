// =============================================================================
// Shared helpers for the Sophos Central Endpoint Groups config type.
//
// A group is reconciled by NAME (Sophos assigns the id on create; `type` is
// immutable — PATCH only accepts name/description). Membership is a static
// list of endpoint ids, fully reconciled every deploy via the group's
// .../endpoints add/remove sub-resource (see lib/sophosApi.ts).
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { sameSet, splitList, str } from '../../lib/sophosCommon'
import type { SophosEndpointGroup } from '../../lib/sophosApi'

export interface EndpointGroupSpec {
  itemName: string
  name: string
  description: string
  type: string
  endpointIds: string[]
}

/** The group's logical identity: its name, trimmed and lower-cased for matching. */
export function endpointGroupKey(name: string): string {
  return name.trim().toLowerCase()
}

export function extractEndpointGroupSpecs(canvas: CanvasSnapshot): EndpointGroupSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: str(fields.name),
      description: str(fields.description),
      type: str(fields.type),
      endpointIds: splitList(fields.endpointIds),
    }
  })
}

/** Build the create request body from a declared spec. */
export function buildEndpointGroupCreateBody(
  spec: EndpointGroupSpec,
): Pick<SophosEndpointGroup, 'name' | 'type'> & Partial<Pick<SophosEndpointGroup, 'description' | 'endpointIds'>> {
  const body: Pick<SophosEndpointGroup, 'name' | 'type'> & Partial<Pick<SophosEndpointGroup, 'description' | 'endpointIds'>> = {
    name: spec.name,
    type: spec.type,
  }
  if (spec.description) body.description = spec.description
  if (spec.endpointIds.length > 0) body.endpointIds = spec.endpointIds
  return body
}

/** Does the live group's name/description already match the declared spec? */
export function endpointGroupDetailsMatch(spec: EndpointGroupSpec, live: SophosEndpointGroup): boolean {
  return live.name === spec.name && (live.description ?? '') === spec.description
}

/** Does the live membership set already match the declared spec, order-insensitively? */
export function endpointGroupMembershipMatches(spec: EndpointGroupSpec, liveMemberIds: string[]): boolean {
  return sameSet(spec.endpointIds, liveMemberIds)
}
