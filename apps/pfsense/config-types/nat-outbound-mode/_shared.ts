// Shared helpers for the (singleton) Outbound NAT Mode config type. Verified
// against RESTAPI/Models/OutboundNATMode.inc — see lib/pfsenseApi.ts's
// module doc for the "manual" vs "advanced" prose/choices mismatch note.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { OutboundNatMode } from '../../lib/pfsenseApi'

export const OUTBOUND_NAT_MODES: OutboundNatMode[] = ['automatic', 'hybrid', 'advanced', 'disabled']

export interface OutboundNatModeSpec {
  itemId?: string
  mode: OutboundNatMode | ''
}

export function extractSpecs(canvas: CanvasSnapshot): OutboundNatModeSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const raw = String(item.fields?.mode ?? '').trim()
    return { itemId: item.id, mode: (OUTBOUND_NAT_MODES as string[]).includes(raw) ? (raw as OutboundNatMode) : '' }
  })
}
