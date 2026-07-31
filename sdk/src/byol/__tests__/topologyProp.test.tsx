import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ByolInfrastructureManager } from '../ByolInfrastructureManager'
import type { ByolInfrastructure, ByolTopology } from '../types'

// =============================================================================
// Generic `topology` prop — the SDK-side fix that stops every BYOL app from
// inheriting Splunk's hardcoded "Indexers"/"Search heads" node pair. An app
// (Fleet, MISP, Wazuh, …) now declares its own N-tier topology; omitting the
// prop keeps the original Splunk-shaped defaults for back-compat.
// =============================================================================

const FLEET_TOPOLOGY: ByolTopology = {
  productName: 'Fleet',
  versionLabel: 'Fleet version',
  infoTooltip: 'Fleet runs a single application tier — no separate indexer/search-head split.',
  tiers: [{ key: 'fleetServers', label: 'Fleet servers', default: 2, min: 1 }],
}

function stubFetch(rows: unknown = []): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => rows })) as unknown as typeof fetch,
  )
}

describe('ByolInfrastructureManager — generic `topology` prop', () => {
  beforeEach(() => stubFetch([]))
  afterEach(() => vi.unstubAllGlobals())

  it('renders one input per declared tier, labelled from the topology, and hides the Splunk indexer/search-head fields', async () => {
    render(<ByolInfrastructureManager apiBase="/api/apps/fleet/byol" topology={FLEET_TOPOLOGY} />)
    await waitFor(() => expect(screen.getByText('New infrastructure')).toBeTruthy())
    fireEvent.click(screen.getByText('New infrastructure'))

    const fleetServers = (await screen.findByLabelText('Fleet servers')) as HTMLInputElement
    expect(fleetServers.value).toBe('2') // seeded from the tier's `default`

    expect(screen.queryByLabelText('Indexers')).toBeNull()
    expect(screen.queryByLabelText('Search heads')).toBeNull()
  })

  it('labels the version picker from `topology.versionLabel` instead of the hardcoded "Splunk version"', async () => {
    render(
      <ByolInfrastructureManager
        apiBase="/api/apps/fleet/byol"
        topology={FLEET_TOPOLOGY}
        versionOptions={[{ value: 'v1', label: '1.0' }]}
      />,
    )
    await waitFor(() => expect(screen.getByText('New infrastructure')).toBeTruthy())
    fireEvent.click(screen.getByText('New infrastructure'))

    expect(await screen.findByLabelText('Fleet version')).toBeTruthy()
    expect(screen.queryByLabelText('Splunk version')).toBeNull()
  })

  it('keeps the original Splunk indexer/search-head fields when no `topology` prop is supplied', async () => {
    render(<ByolInfrastructureManager apiBase="/api/apps/splunk-enterprise/byol" />)
    await waitFor(() => expect(screen.getByText('New infrastructure')).toBeTruthy())
    fireEvent.click(screen.getByText('New infrastructure'))

    expect(await screen.findByLabelText('Indexers')).toBeTruthy()
    expect(screen.getByLabelText('Search heads')).toBeTruthy()
  })

  it('renders a keyboard-accessible info affordance only when `topology.infoTooltip` is set', async () => {
    const { rerender } = render(<ByolInfrastructureManager apiBase="/api/apps/fleet/byol" topology={FLEET_TOPOLOGY} />)
    await waitFor(() => expect(screen.getByText('New infrastructure')).toBeTruthy())
    expect(screen.getByRole('button', { name: FLEET_TOPOLOGY.infoTooltip })).toBeTruthy()

    rerender(<ByolInfrastructureManager apiBase="/api/apps/fleet/byol" topology={{ ...FLEET_TOPOLOGY, infoTooltip: undefined }} />)
    expect(screen.queryByRole('button', { name: FLEET_TOPOLOGY.infoTooltip })).toBeNull()
  })

  it('renders one table column per tier, reading counts from the persisted `tiers` array', async () => {
    const rows: ByolInfrastructure[] = [
      { id: 'i1', name: 'Fleet prod', status: 'running', tiers: [{ key: 'fleetServers', count: 5 }] },
    ]
    stubFetch(rows)
    render(<ByolInfrastructureManager apiBase="/api/apps/fleet/byol" topology={FLEET_TOPOLOGY} />)

    // "Fleet servers" also appears as a SortSelect option — scope to the table header.
    expect(await screen.findByRole('columnheader', { name: 'Fleet servers' })).toBeTruthy()
    expect(await screen.findByText('5')).toBeTruthy() // cell value
  })

  it('falls back to the legacy indexerCount/searchHeadCount fields for a pre-generic-topology row with no `tiers`', async () => {
    // A row persisted before this refactor never wrote `tiers` — the first
    // declared tier must still read the old indexerCount column.
    const rows: ByolInfrastructure[] = [
      { id: 'i1', name: 'Legacy Fleet row', status: 'running', indexerCount: 3 },
    ]
    stubFetch(rows)
    render(<ByolInfrastructureManager apiBase="/api/apps/fleet/byol" topology={FLEET_TOPOLOGY} />)

    expect(await screen.findByText('3')).toBeTruthy()
  })
})
