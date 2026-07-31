import { describe, it, expect } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { OverviewTab } from '../detail/OverviewTab'
import { SettingsTab } from '../detail/SettingsTab'
import { AccessTab } from '../detail/AccessTab'
import type { ByolInfrastructure, ByolResource, ByolTopology } from '../types'

// =============================================================================
// Overview / Settings / Access must show a non-Splunk app's own tier labels and
// product name — never the hardcoded "Indexers"/"Search heads"/"Splunk" the SDK
// used to bake in for every BYOL app.
// =============================================================================

const FLEET_TOPOLOGY: ByolTopology = {
  productName: 'Fleet',
  tiers: [{ key: 'fleetServers', label: 'Fleet servers', default: 2 }],
}

const infra: ByolInfrastructure = {
  id: 'i1',
  name: 'Fleet prod',
  deploymentType: 'distributed',
  status: 'running',
  tiers: [{ key: 'fleetServers', count: 4 }],
}

describe('OverviewTab — generic topology', () => {
  it('renders one stat card per declared tier and no Splunk-specific labels/copy', () => {
    render(<OverviewTab infra={infra} resources={[]} topology={FLEET_TOPOLOGY} />)
    expect(screen.getByText('Fleet servers')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.queryByText('Indexer peers')).toBeNull()
    expect(screen.queryByText('Search heads')).toBeNull()
    expect(screen.getByText(/Fleet topology/)).toBeTruthy()
    expect(screen.queryByText(/Splunk/)).toBeNull()
  })

  it('defaults to the Splunk topology (indexer/search-head stats) when no topology prop is given', () => {
    const splunkInfra: ByolInfrastructure = { ...infra, indexerCount: 6, searchHeadCount: 3, tiers: undefined }
    render(<OverviewTab infra={splunkInfra} resources={[]} />)
    expect(screen.getByText('Indexers')).toBeTruthy()
    expect(screen.getByText('Search heads')).toBeTruthy()
    expect(screen.getByText('6')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })
})

describe('SettingsTab — generic topology', () => {
  const noop = () => {}

  it('summarizes node counts using the tier labels instead of "Indexers / Search heads"', () => {
    render(<SettingsTab infra={infra} busy={false} topology={FLEET_TOPOLOGY} onEdit={noop} onDestroy={noop} onDelete={noop} />)
    expect(screen.getByText('4 Fleet servers')).toBeTruthy()
    expect(screen.queryByText(/Indexers \/ Search heads/)).toBeNull()
  })
})

describe('AccessTab — generic topology', () => {
  function resource(over: Partial<ByolResource>): ByolResource {
    return {
      id: over.planKey ?? 'r',
      infrastructureId: 'i1',
      tier: 'foundation',
      kind: 'network',
      name: 'r',
      role: null,
      region: null,
      status: 'ready',
      externalRef: null,
      message: null,
      planKey: 'foundation/x',
      sortOrder: 0,
      ...over,
    }
  }

  it('labels the web endpoint from `topology.productName` instead of "Splunk Web"', () => {
    const resources = [resource({ planKey: 'foundation/dns', kind: 'dns', externalRef: 'fleet-prod.acme.com' })]
    render(<AccessTab infra={infra} resources={resources} topology={FLEET_TOPOLOGY} />)
    expect(screen.getByText('Fleet Web (search)')).toBeTruthy()
    expect(screen.queryByText('Splunk Web (search)')).toBeNull()
  })
})
