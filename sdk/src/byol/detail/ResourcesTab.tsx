import React from 'react'
import { EmptyState } from '../../ui'
import { TIER_ORDER, TIER_LABELS, type ByolResourceTier } from '../topology'
import type { ByolResource } from '../types'
import { tokens, ResourcePill } from './shared'

const STRIPE: Record<string, string> = {
  ready: tokens.success,
  provisioning: tokens.info,
  attention: tokens.warning,
  failed: tokens.danger,
  not_started: tokens.borderStrong,
}

const LEGEND: Array<{ status: string; label: string }> = [
  { status: 'ready', label: 'Ready' },
  { status: 'provisioning', label: 'Provisioning' },
  { status: 'attention', label: 'Attention' },
  { status: 'failed', label: 'Failed' },
  { status: 'not_started', label: 'Not started' },
]

const ResourceCard: React.FC<{ resource: ByolResource }> = ({ resource }) => (
  <div
    style={{
      position: 'relative',
      border: `1px solid ${tokens.border}`,
      borderRadius: 8,
      background: tokens.surface,
      padding: '12px 13px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      overflow: 'hidden',
    }}
  >
    <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: STRIPE[resource.status] ?? STRIPE.not_started }} />
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ fontWeight: 600, fontSize: 13, color: tokens.text }}>{resource.name}</span>
      <ResourcePill status={resource.status} />
    </div>
    {resource.role ? <div style={{ fontSize: 11, color: tokens.faint }}>{resource.role}</div> : null}
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11, color: tokens.muted }}>
      <span>{resource.zone ? `${resource.region ?? ''} · ${resource.zone}` : resource.region || '—'}</span>
      <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: tokens.faint }}>
        {resource.externalRef || '—'}
      </span>
    </div>
  </div>
)

export interface ResourcesTabProps {
  resources: ByolResource[]
  /** True when the plan is derived from topology (never deployed yet). */
  derived: boolean
}

/**
 * The full end-to-end resource plan, grouped by tier in provisioning order. Each
 * card shows a resource's role, region, status and (once provisioned) its
 * external reference. Before the first deploy this shows the DERIVED plan — what
 * WILL be provisioned — with a hint to deploy.
 */
export const ResourcesTab: React.FC<ResourcesTabProps> = ({ resources, derived }) => {
  if (resources.length === 0) {
    return (
      <EmptyState
        title="No resources planned"
        description="This infrastructure has no derivable topology yet. Check the deployment type and node counts in Settings."
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {derived ? (
        <div
          style={{
            fontSize: 13,
            color: tokens.muted,
            background: tokens.surface2,
            border: `1px solid ${tokens.border}`,
            borderRadius: 8,
            padding: '10px 14px',
          }}
        >
          This is the plan derived from the topology — the resources that <strong>will</strong> be provisioned. Deploy the
          environment to begin creating them.
        </div>
      ) : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, color: tokens.muted }}>
        {LEGEND.map((l) => (
          <span key={l.status} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: STRIPE[l.status] }} />
            {l.label}
          </span>
        ))}
      </div>

      {TIER_ORDER.map((tier) => {
        const inTier = resources.filter((r) => r.tier === (tier as ByolResourceTier))
        if (inTier.length === 0) return null
        const ready = inTier.filter((r) => r.status === 'ready').length
        return (
          <div key={tier}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}>
              <h3
                style={{
                  margin: 0,
                  fontSize: 12,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  color: tokens.primary,
                }}
              >
                {TIER_LABELS[tier as ByolResourceTier]}
              </h3>
              <span style={{ fontSize: 12, color: tokens.faint, fontVariantNumeric: 'tabular-nums' }}>
                {inTier.length} {inTier.length === 1 ? 'resource' : 'resources'}
                {!derived ? ` · ${ready} ready` : ''}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))', gap: 10 }}>
              {inTier.map((r) => (
                <ResourceCard key={r.planKey} resource={r} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
