import { describe, it, expect } from 'vitest'
import { buildByolTags, BYOL_TAG_KEYS, MANAGED_BY } from '../tags'

const BASE = {
  customerId: 'cust-1',
  infrastructureId: 'infra-9',
  name: 'Prod Splunk',
  environmentType: 'prod',
  appId: 'splunk-enterprise',
}

describe('buildByolTags', () => {
  it('emits the canonical keys in the canonical order', () => {
    const tags = buildByolTags(BASE)
    expect(Object.keys(tags)).toEqual([...BYOL_TAG_KEYS])
  })

  it('maps each canonical key to its source value', () => {
    const tags = buildByolTags(BASE)
    expect(tags['Veltrix:Customer']).toBe('cust-1')
    expect(tags['Veltrix:Environment']).toBe('infra-9')
    expect(tags['Veltrix:EnvName']).toBe('Prod Splunk')
    expect(tags['Veltrix:EnvType']).toBe('prod')
    expect(tags['Veltrix:App']).toBe('splunk-enterprise')
    expect(tags['Veltrix:ManagedBy']).toBe(MANAGED_BY)
  })

  it('falls back CostCenter and Owner to the customerId', () => {
    const tags = buildByolTags(BASE)
    expect(tags.CostCenter).toBe('cust-1')
    expect(tags.Owner).toBe('cust-1')
  })

  it('honours an explicit costCenter and owner when provided', () => {
    const tags = buildByolTags({ ...BASE, costCenter: 'CC-42', owner: 'user-7' })
    expect(tags.CostCenter).toBe('CC-42')
    expect(tags.Owner).toBe('user-7')
  })

  it('trims values and falls back on blank costCenter / owner', () => {
    const tags = buildByolTags({ ...BASE, name: '  Prod Splunk  ', costCenter: '   ', owner: '' })
    expect(tags['Veltrix:EnvName']).toBe('Prod Splunk')
    expect(tags.CostCenter).toBe('cust-1')
    expect(tags.Owner).toBe('cust-1')
  })

  it('uses the customer shortname for Customer / CostCenter / Owner when set', () => {
    const tags = buildByolTags({ ...BASE, customerShortName: 'acme-prod' })
    expect(tags['Veltrix:Customer']).toBe('acme-prod')
    expect(tags.CostCenter).toBe('acme-prod')
    expect(tags.Owner).toBe('acme-prod')
  })

  it('falls back to the customerId when the shortname is blank/absent', () => {
    expect(buildByolTags({ ...BASE, customerShortName: '   ' })['Veltrix:Customer']).toBe('cust-1')
    expect(buildByolTags({ ...BASE, customerShortName: null })['Veltrix:Customer']).toBe('cust-1')
  })

  it('lets an explicit costCenter / owner override the shortname', () => {
    const tags = buildByolTags({ ...BASE, customerShortName: 'acme-prod', costCenter: 'CC-42', owner: 'user-7' })
    expect(tags.CostCenter).toBe('CC-42')
    expect(tags.Owner).toBe('user-7')
  })

  it('is pure — the same input yields an equal map', () => {
    expect(buildByolTags(BASE)).toEqual(buildByolTags(BASE))
  })
})
