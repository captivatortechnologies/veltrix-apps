import React from 'react'
import { TIER_LABELS, type ByolResourceTier } from '../topology'
import type { PlanAction, ByolPlan } from '../diffPlan'
import { tokens } from './shared'

// =============================================================================
// planLines — the resource-row rendering shared by every Terraform-style plan
// preview: the Apply-plan modal (`ByolPlanModal`, add/change/destroy/noop) and
// the Destroy-plan modal (`DestroyPlanModal`, destroy-only). Kept in one place
// so the two stay pixel-identical and neither duplicates the other's markup.
// =============================================================================

/** Per-action visual language: glyph + colour + short label. */
export const ACTION_META: Record<PlanAction, { glyph: string; color: string; label: string }> = {
  add: { glyph: '+', color: tokens.success, label: 'add' },
  change: { glyph: '~', color: tokens.warning, label: 'change' },
  destroy: { glyph: '−', color: tokens.danger, label: 'destroy' },
  noop: { glyph: '·', color: tokens.faint, label: 'no change' },
}

export const tierLabel = (tier: string): string =>
  TIER_LABELS[tier as ByolResourceTier] ?? tier.replace(/-/g, ' ')

/** One resource line in a plan, tagged with its +/~/− action glyph. */
export const PlanLine: React.FC<{ item: ByolPlan['groups'][number]['items'][number] }> = ({ item }) => {
  const meta = ACTION_META[item.action]
  return (
    <div
      style={{
        position: 'relative',
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        background: tokens.surface,
        padding: '10px 12px 10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        overflow: 'hidden',
      }}
    >
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: meta.color }} />
      <span
        aria-hidden
        title={meta.label}
        style={{
          flex: 'none',
          width: 20,
          height: 20,
          borderRadius: 5,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          fontSize: 14,
          lineHeight: 1,
          color: meta.color,
          background: tokens.surface2,
        }}
      >
        {meta.glyph}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: tokens.text, textDecoration: item.action === 'destroy' ? 'line-through' : 'none' }}>
          {item.name}
        </div>
        {item.role ? <div style={{ fontSize: 11, color: tokens.faint }}>{item.role}</div> : null}
      </div>
      <span style={{ fontSize: 11, color: tokens.muted, flex: 'none' }}>{item.region || '—'}</span>
    </div>
  )
}

/** A titled group of plan lines for one provisioning tier. */
export const PlanGroup: React.FC<{ tier: string; items: ByolPlan['groups'][number]['items'] }> = ({ tier, items }) => (
  <div>
    <h3
      style={{
        margin: '0 0 8px',
        fontSize: 12,
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: tokens.primary,
      }}
    >
      {tierLabel(tier)}
    </h3>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item) => (
        <PlanLine key={item.planKey} item={item} />
      ))}
    </div>
  </div>
)
