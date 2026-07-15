import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ByolInfrastructureManager } from '../ByolInfrastructureManager'
import { ByolInfrastructureDetail } from '../ByolInfrastructureDetail'
import type { ByolInfrastructure } from '../types'

// The components read their real UI off the host runtime; outside the platform
// they render accessible fallbacks. These smoke tests mount the actual React
// trees (manager + detail) to prove they render — and route between sections —
// without throwing, complementing the pure topology tests.

function stubFetch(rows: unknown = []): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => rows })) as unknown as typeof fetch,
  )
}

const NOT_STARTED: ByolInfrastructure = {
  id: 'i1',
  name: 'Test Cluster',
  deploymentType: 'distributed',
  indexerCount: 3,
  searchHeadCount: 2,
  status: 'not_started',
  hosting_type: 'AWS',
  cloudProviderId: 'cp1',
  region: 'us-east-1',
}

describe('ByolInfrastructureManager (fallback render)', () => {
  beforeEach(() => stubFetch([]))
  afterEach(() => vi.unstubAllGlobals())

  it('renders the list card and empty state without throwing', async () => {
    render(<ByolInfrastructureManager apiBase="/api/apps/x/byol" title="BYOL Splunk Infrastructure" />)
    expect(screen.getByText('BYOL Splunk Infrastructure')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/No BYOL infrastructure yet/i)).toBeTruthy())
  })
})

describe('ByolInfrastructureDetail (fallback render)', () => {
  beforeEach(() => stubFetch([]))
  afterEach(() => vi.unstubAllGlobals())

  const noop = () => {}
  const renderDetail = () =>
    render(
      <ByolInfrastructureDetail
        apiBase="/api/apps/x/byol"
        initialInfra={NOT_STARTED}
        onBack={noop}
        onEdit={noop}
        onDeleted={noop}
        onChanged={noop}
      />,
    )

  it('renders the header, every sidebar section, and a status-adaptive primary action', async () => {
    renderDetail()
    expect(screen.getByText('Test Cluster')).toBeTruthy()
    expect(screen.getByText(/Back to infrastructure/)).toBeTruthy()
    // sidebar nav buttons carry their label as a title — unambiguous.
    for (const s of ['Overview', 'Resources', 'Activity', 'Access', 'Configuration', 'Settings']) {
      expect(screen.getByTitle(s)).toBeTruthy()
    }
    // not_started → the primary action offers to deploy
    expect(screen.getByText('Deploy environment')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/What gets deployed/i)).toBeTruthy())
  })

  it('shows the derived resource plan (grouped by tier) on the Resources section before any deploy', async () => {
    renderDetail()
    fireEvent.click(screen.getByTitle('Resources'))
    expect(screen.getByText(/plan derived from the topology/i)).toBeTruthy()
    // tiers + representative resources from the distributed topology
    expect(screen.getByText('Foundation')).toBeTruthy()
    expect(screen.getByText('Cluster Manager')).toBeTruthy()
    expect(screen.getByText('Indexer peer 1')).toBeTruthy()
  })
})
