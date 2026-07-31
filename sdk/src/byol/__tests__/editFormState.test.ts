import { describe, it, expect } from 'vitest'
import { editFormState, blankForm, tierValue, BLANK_FORM, DEFAULT_SPLUNK_TOPOLOGY } from '../types'
import type { ByolInfrastructure, ByolTopology } from '../types'

describe('editFormState — Edit topology renders accurate state', () => {
  it('maps every persisted field back into the form (strings for numeric inputs), tiers keyed by the Splunk topology', () => {
    const row: ByolInfrastructure = {
      id: 'i1',
      name: 'Prod cluster',
      deploymentType: 'distributed',
      environmentType: 'prod',
      cloudProviderId: 'cp-aws',
      region: 'us-east-1',
      indexerCount: 6,
      searchHeadCount: 3,
      networkMode: 'dedicated',
      dnsMode: 'delegated',
      cloudAccountConnectionId: 'acct-1',
      controlPlaneLayout: 'consolidated',
      heavyForwarderCount: 2,
      instanceType: 't3.large',
      indexerPlacement: {
        mode: 'multi-site',
        granularity: 'az',
        sites: [
          { site: 'us-east-1a', percent: 60 },
          { site: 'us-east-1b', percent: 40 },
        ],
      },
      searchHeadPlacement: { mode: 'single' },
      versionId: 'v-10-4',
      status: 'failed',
    }

    expect(editFormState(row, DEFAULT_SPLUNK_TOPOLOGY)).toEqual({
      name: 'Prod cluster',
      deploymentType: 'distributed',
      environmentType: 'prod',
      providerId: 'cp-aws',
      region: 'us-east-1',
      tierCounts: { indexer: '6', searchHead: '3' },
      tierPlacement: {
        indexer: {
          mode: 'multi-site',
          granularity: 'az',
          sites: [
            { site: 'us-east-1a', percent: 60 },
            { site: 'us-east-1b', percent: 40 },
          ],
        },
        searchHead: { mode: 'single' },
      },
      networkMode: 'dedicated',
      dnsMode: 'delegated',
      cloudAccountConnectionId: 'acct-1',
      controlPlaneLayout: 'consolidated',
      heavyForwarderCount: '2',
      instanceType: 't3.large',
      versionId: 'v-10-4',
    })
  })

  it('falls back to new-form defaults for a legacy/minimal row', () => {
    const form = editFormState({ id: 'i', name: 'x', status: 'active' } as ByolInfrastructure)
    expect(form.deploymentType).toBe('single')
    expect(form.networkMode).toBe('shared')
    expect(form.dnsMode).toBe('managed')
    expect(form.controlPlaneLayout).toBe('dedicated')
    expect(form.heavyForwarderCount).toBe('1')
    expect(form.instanceType).toBe('')
    expect(form.tierCounts).toEqual({ indexer: '1', searchHead: '1' })
    expect(form.tierPlacement).toEqual({ indexer: { mode: 'single' }, searchHead: { mode: 'single' } })
    expect(form.versionId).toBe('')
  })

  it('resolves a self-hosted row to the SELF_HOSTED provider sentinel', () => {
    const form = editFormState({ id: 'i', name: 'x', hosting_type: 'Self-Hosted', status: 'active' } as ByolInfrastructure)
    expect(form.providerId).toBe('self-hosted')
  })

  it('reads a generic app topology from a persisted tiers array (not the legacy Splunk fields)', () => {
    const fleetTopology: ByolTopology = {
      productName: 'Fleet',
      tiers: [{ key: 'fleetServers', label: 'Fleet servers', min: 1 }],
    }
    const row: ByolInfrastructure = {
      id: 'i2',
      name: 'Fleet prod',
      status: 'active',
      tiers: [{ key: 'fleetServers', count: 4, placement: { mode: 'single' } }],
    }
    const form = editFormState(row, fleetTopology)
    expect(form.tierCounts).toEqual({ fleetServers: '4' })
    expect(form.tierPlacement).toEqual({ fleetServers: { mode: 'single' } })
  })
})

describe('tierValue — Splunk back-compat fallback for rows with no `tiers` array', () => {
  const { tiers } = DEFAULT_SPLUNK_TOPOLOGY

  it('reads the first tier from indexerCount and the second from searchHeadCount', () => {
    const row: ByolInfrastructure = { id: 'i', name: 'x', indexerCount: 5, searchHeadCount: 2 }
    expect(tierValue(row, tiers[0], 0)).toBe(5)
    expect(tierValue(row, tiers[1], 1)).toBe(2)
  })

  it('prefers a persisted `tiers` entry over the legacy fields', () => {
    const row: ByolInfrastructure = {
      id: 'i',
      name: 'x',
      indexerCount: 5,
      tiers: [{ key: 'indexer', count: 9 }],
    }
    expect(tierValue(row, tiers[0], 0)).toBe(9)
  })

  it('has no fallback for a third-plus tier position', () => {
    const row: ByolInfrastructure = { id: 'i', name: 'x' }
    const thirdTier = { key: 'extra', label: 'Extra' }
    expect(tierValue(row, thirdTier, 2)).toBeUndefined()
  })
})

describe('new-infra default deployment target', () => {
  it('defaults a fresh form to dedicated (OpenTofu provisions its own VPC)', () => {
    // Shared attaches to a platform base network that does not yet exist, so new
    // infra must not default into it. Existing rows still reflect their stored value.
    expect(BLANK_FORM.networkMode).toBe('dedicated')
  })

  it('leaves versionId blank — the manager seeds it from defaultVersionId at open-create time', () => {
    expect(BLANK_FORM.versionId).toBe('')
  })

  it('blankForm seeds tierCounts/tierPlacement from the given topology (default → 1, single placement)', () => {
    const topology: ByolTopology = {
      productName: 'Wazuh',
      tiers: [
        { key: 'indexer', label: 'Wazuh indexer nodes', default: 3 },
        { key: 'manager', label: 'Manager workers' },
      ],
    }
    const form = blankForm(topology)
    expect(form.tierCounts).toEqual({ indexer: '3', manager: '1' })
    expect(form.tierPlacement).toEqual({ indexer: { mode: 'single' }, manager: { mode: 'single' } })
  })
})
