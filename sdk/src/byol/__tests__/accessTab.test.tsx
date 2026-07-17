import { describe, it, expect } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { AccessTab } from '../detail/AccessTab'
import type { ByolInfrastructure, ByolResource } from '../types'

const infra: ByolInfrastructure = { id: 'i1', name: 'Test Prod', status: 'active' }

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

describe('AccessTab — real endpoints only, no fabricated hosts', () => {
  it('shows the pending state (never example.com) when refs are not real hostnames', () => {
    // Mirrors a stub run: refs are placeholders like "stub-foundation/dns".
    const resources = [
      resource({ planKey: 'foundation/dns', kind: 'dns', externalRef: 'stub-foundation/dns' }),
      resource({ planKey: 'ingest/hec', kind: 'hec', externalRef: 'stub-ingest/hec' }),
      resource({ planKey: 'data/indexer-1', kind: 'indexer', externalRef: 'stub-data/indexer-1' }),
    ]
    const { container } = render(<AccessTab infra={infra} resources={resources} />)

    expect(container.textContent).not.toMatch(/example\.com/i)
    expect(screen.getByText(/has not reported a reachable endpoint yet/i)).toBeTruthy()
  })

  it('derives real endpoints from the managed DNS + ALB refs', () => {
    const resources = [
      resource({ planKey: 'foundation/dns', kind: 'dns', externalRef: 'test-prod.splunk.acme.com' }),
      resource({ planKey: 'ingest/hec', kind: 'hec', externalRef: 'env-alb-123.us-east-1.elb.amazonaws.com' }),
      resource({ planKey: 'data/indexer-1', kind: 'indexer', externalRef: 'idx1.splunk.acme.com' }),
      resource({ planKey: 'data/indexer-2', kind: 'indexer', externalRef: 'idx2.splunk.acme.com' }),
    ]
    const { container } = render(<AccessTab infra={infra} resources={resources} />)

    expect(screen.getByText('https://test-prod.splunk.acme.com')).toBeTruthy()
    expect(screen.getByText('https://test-prod.splunk.acme.com:8089')).toBeTruthy()
    // HEC lives on the ALB DNS name.
    expect(
      screen.getByText('https://env-alb-123.us-east-1.elb.amazonaws.com:8088/services/collector'),
    ).toBeTruthy()
    // Forwarder targets come from the real indexer peer addresses.
    expect(container.textContent).toContain('idx1.splunk.acme.com:9997, idx2.splunk.acme.com:9997')
    expect(container.textContent).not.toMatch(/example\.com/i)
  })

  it('shows the not-running empty state before deploy', () => {
    render(<AccessTab infra={{ ...infra, status: 'not_started' }} resources={[]} />)
    expect(screen.getByText(/Endpoints appear once the environment is running/i)).toBeTruthy()
  })

  it('notes pending forwarder targets when indexers have no real address yet', () => {
    const resources = [
      resource({ planKey: 'foundation/dns', kind: 'dns', externalRef: 'test-prod.splunk.acme.com' }),
      resource({ planKey: 'data/indexer-1', kind: 'indexer', externalRef: 'stub-data/indexer-1' }),
    ]
    render(<AccessTab infra={infra} resources={resources} />)
    expect(screen.getByText(/Forwarder targets appear here once the indexer peers report/i)).toBeTruthy()
  })
})
