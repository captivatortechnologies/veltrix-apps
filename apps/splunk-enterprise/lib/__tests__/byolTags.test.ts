import { buildByolTags, BYOL_TAG_KEYS, MANAGED_BY } from '../byolTags'

// =============================================================================
// App-owned tag builder — mirror of the SDK's; this pins the copy to the same
// canonical contract (keys, order, fallbacks) so the two never drift.
// =============================================================================

const BASE = {
  customerId: 'cust-1',
  infrastructureId: 'infra-9',
  name: 'Prod Splunk',
  environmentType: 'prod',
  appId: 'splunk-enterprise',
}

describe('buildByolTags (app copy)', () => {
  it('emits the canonical keys in the canonical order', () => {
    expect(Object.keys(buildByolTags(BASE))).toEqual([...BYOL_TAG_KEYS])
  })

  it('maps every source value and stamps a constant ManagedBy', () => {
    const tags = buildByolTags(BASE)
    expect(tags['Veltrix:Customer']).toBe('cust-1')
    expect(tags['Veltrix:Environment']).toBe('infra-9')
    expect(tags['Veltrix:EnvName']).toBe('Prod Splunk')
    expect(tags['Veltrix:EnvType']).toBe('prod')
    expect(tags['Veltrix:App']).toBe('splunk-enterprise')
    expect(tags['Veltrix:ManagedBy']).toBe(MANAGED_BY)
  })

  it('falls CostCenter + Owner back to the customerId, honours overrides', () => {
    expect(buildByolTags(BASE).CostCenter).toBe('cust-1')
    expect(buildByolTags(BASE).Owner).toBe('cust-1')
    const custom = buildByolTags({ ...BASE, costCenter: 'CC-42', owner: 'user-7' })
    expect(custom.CostCenter).toBe('CC-42')
    expect(custom.Owner).toBe('user-7')
  })

  it('uses the customer shortname when set, else the UUID', () => {
    expect(buildByolTags({ ...BASE, customerShortName: 'acme-prod' })['Veltrix:Customer']).toBe('acme-prod')
    expect(buildByolTags({ ...BASE, customerShortName: null })['Veltrix:Customer']).toBe('cust-1')
  })
})
