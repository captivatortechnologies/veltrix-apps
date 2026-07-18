import { describe, it, expect } from 'vitest'
import { editFormState, BLANK_FORM } from '../types'
import type { ByolInfrastructure } from '../types'

describe('editFormState — Edit topology renders accurate state', () => {
  it('maps every persisted field back into the form (strings for numeric inputs)', () => {
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

    expect(editFormState(row)).toEqual({
      name: 'Prod cluster',
      deploymentType: 'distributed',
      environmentType: 'prod',
      providerId: 'cp-aws',
      region: 'us-east-1',
      indexerCount: '6',
      searchHeadCount: '3',
      networkMode: 'dedicated',
      dnsMode: 'delegated',
      cloudAccountConnectionId: 'acct-1',
      controlPlaneLayout: 'consolidated',
      heavyForwarderCount: '2',
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
    expect(form.indexerPlacement).toEqual({ mode: 'single' })
    expect(form.searchHeadPlacement).toEqual({ mode: 'single' })
    expect(form.versionId).toBe('')
  })

  it('resolves a self-hosted row to the SELF_HOSTED provider sentinel', () => {
    const form = editFormState({ id: 'i', name: 'x', hosting_type: 'Self-Hosted', status: 'active' } as ByolInfrastructure)
    expect(form.providerId).toBe('self-hosted')
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
})
