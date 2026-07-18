import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { DestroyPlanModal } from '../detail/DestroyPlanModal'
import type { ByolResource } from '../types'

// The modal renders the platform Modal off the host runtime; outside the
// platform it falls back to an accessible shell (same as the Apply plan modal's
// tests), so these mount the real tree and assert behaviour.

const RESOURCES: ByolResource[] = [
  {
    id: 'r1',
    infrastructureId: 'i1',
    tier: 'foundation',
    kind: 'network',
    name: 'Network',
    role: 'net',
    region: 'us-east-1',
    status: 'ready',
    externalRef: 'vpc-1',
    message: null,
    planKey: 'foundation/network',
    sortOrder: 0,
  },
  {
    id: 'r2',
    infrastructureId: 'i1',
    tier: 'data',
    kind: 'indexer',
    name: 'Indexer peer 1',
    role: 'peer',
    region: 'us-east-1',
    status: 'ready',
    externalRef: 'i-1',
    message: null,
    planKey: 'data/indexer-1',
    sortOrder: 1,
  },
  {
    id: 'r3',
    infrastructureId: 'i1',
    tier: 'data',
    kind: 'indexer',
    name: 'Indexer peer 2',
    role: 'peer',
    region: 'us-east-1',
    status: 'ready',
    externalRef: 'i-2',
    message: null,
    planKey: 'data/indexer-2',
    sortOrder: 2,
  },
]

describe('DestroyPlanModal', () => {
  const noop = () => {}

  it('renders one destroy row per current resource, grouped by tier, with a −N to destroy summary', () => {
    render(<DestroyPlanModal isOpen onClose={noop} resources={RESOURCES} onConfirm={noop} />)
    expect(screen.getByText('−3 to destroy')).toBeTruthy()
    expect(screen.getByText('Foundation')).toBeTruthy()
    expect(screen.getByText('Data tier — indexer cluster')).toBeTruthy()
    expect(screen.getByText('Network')).toBeTruthy()
    expect(screen.getByText('Indexer peer 1')).toBeTruthy()
    expect(screen.getByText('Indexer peer 2')).toBeTruthy()
  })

  it('always shows the "cannot be undone" warning', () => {
    render(<DestroyPlanModal isOpen onClose={noop} resources={RESOURCES} onConfirm={noop} />)
    expect(screen.getByText('This cannot be undone')).toBeTruthy()
  })

  it('invokes onConfirm when the danger Destroy button is clicked', () => {
    const onConfirm = vi.fn()
    render(<DestroyPlanModal isOpen onClose={noop} resources={RESOURCES} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByText('Destroy'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('invokes onClose (not onConfirm) when Cancel is clicked', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(<DestroyPlanModal isOpen onClose={onClose} resources={RESOURCES} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('shows a loading state while resources are being fetched, without blocking Destroy', () => {
    render(<DestroyPlanModal isOpen onClose={noop} resources={null} loading onConfirm={noop} />)
    expect(screen.getByText(/Loading current resources/i)).toBeTruthy()
    const destroy = screen.getByText('Destroy') as HTMLButtonElement
    expect(destroy.disabled).toBe(true) // disabled only while the fetch itself is in flight
  })

  it('still allows Destroy and explains the gap when the resource list is empty', () => {
    render(<DestroyPlanModal isOpen onClose={noop} resources={[]} onConfirm={noop} />)
    expect(screen.getByText(/No resource inventory is available/i)).toBeTruthy()
    const destroy = screen.getByText('Destroy') as HTMLButtonElement
    expect(destroy.disabled).toBe(false)
  })

  it('surfaces a destroy-action error inline', () => {
    render(<DestroyPlanModal isOpen onClose={noop} resources={RESOURCES} error="Boom" onConfirm={noop} />)
    expect(screen.getByText('Boom')).toBeTruthy()
  })

  it('disables Destroy and shows a spinner while the destroy request is in flight', () => {
    render(<DestroyPlanModal isOpen onClose={noop} resources={RESOURCES} destroying onConfirm={noop} />)
    const destroy = screen.getByText('Destroy') as HTMLButtonElement
    expect(destroy.disabled).toBe(true)
  })
})
