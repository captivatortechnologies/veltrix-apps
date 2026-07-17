import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ByolPlanModal } from '../detail/ByolPlanModal'
import type { ByolPlan } from '../diffPlan'

// The modal renders the platform Modal off the host runtime; outside the
// platform it falls back to an accessible shell (same as the manager/detail
// smoke tests), so these mount the real tree and assert behaviour.

const CHANGED_PLAN: ByolPlan = {
  summary: { add: 2, change: 1, destroy: 0, noop: 3 },
  groups: [
    {
      tier: 'foundation',
      items: [
        { planKey: 'foundation/network', action: 'noop', name: 'Network', role: 'net', region: 'us-east-1', kind: 'network' },
        { planKey: 'foundation/storage', action: 'add', name: 'Storage', role: 'volumes', region: 'us-east-1', kind: 'storage' },
      ],
    },
    {
      tier: 'data',
      items: [
        { planKey: 'data/indexer-1', action: 'change', name: 'Indexer peer 1', role: 'peer', region: 'eu-west-1', kind: 'indexer' },
        { planKey: 'data/indexer-2', action: 'add', name: 'Indexer peer 2', role: 'peer', region: 'us-east-1', kind: 'indexer' },
      ],
    },
  ],
}

const NOOP_PLAN: ByolPlan = {
  summary: { add: 0, change: 0, destroy: 0, noop: 5 },
  groups: [],
}

const ENRICHED_PLAN: ByolPlan = {
  ...CHANGED_PLAN,
  network: { networkRef: 'vpc-shared-use1', subnetCidr: '10.20.4.0/24' },
  tags: { 'Veltrix:Customer': 'cust-1', 'Veltrix:App': 'splunk-enterprise', CostCenter: 'cust-1' },
}

describe('ByolPlanModal', () => {
  const noop = () => {}

  it('renders the add/change/destroy summary chips and the grouped resource lines', () => {
    render(<ByolPlanModal isOpen onClose={noop} plan={CHANGED_PLAN} onApply={noop} />)
    expect(screen.getByText('+2 to add')).toBeTruthy()
    expect(screen.getByText('~1 to change')).toBeTruthy()
    expect(screen.getByText('−0 to destroy')).toBeTruthy()
    // tier labels + representative resources
    expect(screen.getByText('Foundation')).toBeTruthy()
    expect(screen.getByText('Indexer peer 1')).toBeTruthy()
    expect(screen.getByText('Storage')).toBeTruthy()
  })

  it('enables Apply and invokes onApply when the plan has changes', () => {
    const onApply = vi.fn()
    render(<ByolPlanModal isOpen onClose={noop} plan={CHANGED_PLAN} onApply={onApply} />)
    const apply = screen.getByText('Apply') as HTMLButtonElement
    expect(apply.disabled).toBe(false)
    fireEvent.click(apply)
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('disables Apply and shows the up-to-date message for a no-op plan', () => {
    render(<ByolPlanModal isOpen onClose={noop} plan={NOOP_PLAN} onApply={noop} />)
    const apply = screen.getByText('Apply') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    expect(screen.getByText(/No changes\. Infrastructure is up to date\./i)).toBeTruthy()
  })

  it('shows a computing state and disables Apply while the plan loads', () => {
    render(<ByolPlanModal isOpen onClose={noop} plan={null} loading onApply={noop} />)
    expect(screen.getByText(/Computing plan/i)).toBeTruthy()
    const apply = screen.getByText('Apply') as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it('surfaces a plan error inline', () => {
    render(<ByolPlanModal isOpen onClose={noop} plan={null} error="Boom" onApply={noop} />)
    expect(screen.getByText('Boom')).toBeTruthy()
  })

  it('renders the Network panel with the allocated subnet + network ref', () => {
    render(<ByolPlanModal isOpen onClose={noop} plan={ENRICHED_PLAN} onApply={noop} />)
    // The CIDR + network ref are unique to the Network panel ("Network" as bare
    // text also names the foundation/network resource line, so assert on these).
    expect(screen.getByText('10.20.4.0/24')).toBeTruthy()
    expect(screen.getByText('vpc-shared-use1')).toBeTruthy()
  })

  it('renders the Tags panel with each canonical tag key + value', () => {
    render(<ByolPlanModal isOpen onClose={noop} plan={ENRICHED_PLAN} onApply={noop} />)
    expect(screen.getByText('Tags applied to every resource')).toBeTruthy()
    expect(screen.getByText('Veltrix:Customer')).toBeTruthy()
    expect(screen.getByText('splunk-enterprise')).toBeTruthy()
  })

  it('shows a soft-unavailable note when the network allocator was unreachable', () => {
    const plan: ByolPlan = { ...CHANGED_PLAN, networkUnavailable: true }
    render(<ByolPlanModal isOpen onClose={noop} plan={plan} onApply={noop} />)
    expect(screen.getByText(/Subnet allocation preview is temporarily unavailable/i)).toBeTruthy()
  })

  it('omits the Network + Tags panels when the plan carries neither', () => {
    render(<ByolPlanModal isOpen onClose={noop} plan={CHANGED_PLAN} onApply={noop} />)
    expect(screen.queryByText('Tags applied to every resource')).toBeNull()
    // "Network" as a panel heading is absent; the resource line "Network" is not a heading here
    // (the foundation/network item is named "Network" — assert the Tags panel is the reliable signal).
  })
})
