import React from 'react'
import { Modal, Button, Badge, Spinner } from '../../ui'
import { TIER_LABELS, type ByolResourceTier } from '../topology'
import { planHasChanges, type ByolPlan, type PlanAction } from '../diffPlan'
import { tokens } from './shared'

// =============================================================================
// ByolPlanModal — a Terraform-style "Plan" preview shown before Apply.
//
// Renders the side-effect-free plan returned by `GET /byol/:id/plan`: header
// summary chips (`+N to add · ~M to change · −Z to destroy`), then every
// resource line grouped by tier in provisioning order, each tagged with a
// +/~/− action glyph. The footer's primary Apply button triggers the real
// deploy (the caller wires it to POST /deploy) and is disabled when the plan is
// a no-op. App-agnostic: no app-specific strings live here.
// =============================================================================

export interface ByolPlanModalProps {
  isOpen: boolean
  onClose: () => void
  /** The computed plan, or null while it is still loading. */
  plan: ByolPlan | null
  /** True while the plan is being fetched. */
  loading?: boolean
  /** A plan-fetch or apply error to surface inline. */
  error?: string | null
  /** True while Apply is in flight. */
  applying?: boolean
  /** Invoked by the primary Apply button. */
  onApply: () => void
  /** Optional environment name, shown in the subtitle. */
  infraName?: string
  /**
   * Allow Apply even when the plan has no add/change/destroy — for a redeployable
   * environment (a failed or never-deployed infra) where the user is RE-running
   * the same plan rather than making a change.
   */
  allowApplyWithoutChanges?: boolean
}

/** Per-action visual language: glyph + colour + short label. */
const ACTION_META: Record<PlanAction, { glyph: string; color: string; label: string }> = {
  add: { glyph: '+', color: tokens.success, label: 'add' },
  change: { glyph: '~', color: tokens.warning, label: 'change' },
  destroy: { glyph: '−', color: tokens.danger, label: 'destroy' },
  noop: { glyph: '·', color: tokens.faint, label: 'no change' },
}

const tierLabel = (tier: string): string =>
  TIER_LABELS[tier as ByolResourceTier] ?? tier.replace(/-/g, ' ')

/** A titled, bordered panel matching the modal's card styling. */
const InfoPanel: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 8, background: tokens.surface2, overflow: 'hidden' }}>
    <div
      style={{
        padding: '8px 12px',
        borderBottom: `1px solid ${tokens.border}`,
        fontSize: 11,
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: tokens.primary,
        fontWeight: 700,
      }}
    >
      {title}
    </div>
    <div style={{ padding: '10px 12px' }}>{children}</div>
  </div>
)

/** Network panel: the subnet the allocator will carve, or a soft-unavailable note. */
const NetworkPanel: React.FC<{ plan: ByolPlan }> = ({ plan }) => {
  if (!plan.network) {
    if (!plan.networkUnavailable) return null
    return (
      <InfoPanel title="Network">
        <div style={{ fontSize: 13, color: tokens.muted }}>
          Subnet allocation preview is temporarily unavailable — the CIDR is reserved when you apply.
        </div>
      </InfoPanel>
    )
  }
  return (
    <InfoPanel title="Network">
      <div style={{ fontSize: 13, color: tokens.text }}>
        Subnet{' '}
        <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: tokens.primary }}>
          {plan.network.subnetCidr}
        </code>{' '}
        will be allocated in{' '}
        <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: tokens.text }}>
          {plan.network.networkRef}
        </code>
        .
      </div>
    </InfoPanel>
  )
}

/** Tags panel: every canonical cost/tenant tag each resource will carry. */
const TagsPanel: React.FC<{ plan: ByolPlan }> = ({ plan }) => {
  const entries = plan.tags ? Object.entries(plan.tags) : []
  if (entries.length === 0) return null
  return (
    <InfoPanel title="Tags applied to every resource">
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12 }}>
        {entries.map(([key, value]) => (
          <React.Fragment key={key}>
            <span
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: tokens.muted,
                whiteSpace: 'nowrap',
              }}
            >
              {key}
            </span>
            <span style={{ color: tokens.text, wordBreak: 'break-all' }}>{value}</span>
          </React.Fragment>
        ))}
      </div>
    </InfoPanel>
  )
}

const SummaryChips: React.FC<{ plan: ByolPlan }> = ({ plan }) => {
  const { add, change, destroy } = plan.summary
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <Badge variant="success" size="sm">+{add} to add</Badge>
      <Badge variant="warning" size="sm">~{change} to change</Badge>
      <Badge variant="danger" size="sm">−{destroy} to destroy</Badge>
      {plan.summary.noop > 0 ? (
        <span style={{ fontSize: 12, color: tokens.faint }}>{plan.summary.noop} unchanged</span>
      ) : null}
    </div>
  )
}

const PlanLine: React.FC<{ item: ByolPlan['groups'][number]['items'][number] }> = ({ item }) => {
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
          background: 'var(--color-surface-secondary, #f9fafb)',
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

const PlanBody: React.FC<{
  plan: ByolPlan | null
  loading?: boolean
  error?: string | null
  allowApplyWithoutChanges?: boolean
}> = ({ plan, loading, error, allowApplyWithoutChanges }) => {
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 0', color: tokens.muted, fontSize: 13 }}>
        <Spinner size="sm" /> Computing plan…
      </div>
    )
  }
  if (error) {
    return <div style={{ padding: '12px 0', color: tokens.danger, fontSize: 13 }}>{error}</div>
  }
  if (!plan) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SummaryChips plan={plan} />
      <NetworkPanel plan={plan} />
      <TagsPanel plan={plan} />
      {!planHasChanges(plan.summary) ? (
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
          {allowApplyWithoutChanges
            ? 'No plan changes — the previous run did not complete. Apply to re-run the deployment with the same plan.'
            : 'No changes. Infrastructure is up to date.'}
        </div>
      ) : (
        plan.groups.map((group) => (
          <div key={group.tier}>
            <h3
              style={{
                margin: '0 0 8px',
                fontSize: 12,
                letterSpacing: '.08em',
                textTransform: 'uppercase',
                color: tokens.primary,
              }}
            >
              {tierLabel(group.tier)}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {group.items.map((item) => (
                <PlanLine key={item.planKey} item={item} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

/**
 * The Plan modal. Fetch the plan into `plan` (showing `loading` first), then let
 * the user Apply. Apply is disabled while loading, while applying, and when the
 * plan has no add/change/destroy.
 */
export const ByolPlanModal: React.FC<ByolPlanModalProps> = ({
  isOpen,
  onClose,
  plan,
  loading,
  error,
  applying,
  onApply,
  infraName,
  allowApplyWithoutChanges,
}) => {
  const noChanges = !plan || !planHasChanges(plan.summary)
  const applyDisabled = loading || applying || (noChanges && !allowApplyWithoutChanges)

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title="Review deployment plan"
      subtitle={infraName ? `Changes that will be applied to ${infraName}.` : 'Changes that will be applied to this environment.'}
      disableBackdropClose={applying}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={onApply} isLoading={applying} disabled={applyDisabled}>
            Apply
          </Button>
        </>
      }
    >
      <PlanBody plan={plan} loading={loading} error={error} allowApplyWithoutChanges={allowApplyWithoutChanges} />
    </Modal>
  )
}

export default ByolPlanModal
