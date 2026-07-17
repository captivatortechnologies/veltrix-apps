import { readByol } from '../byolInput'

// =============================================================================
// BYOL request validation — scalar coercion, distributed guardrails, and the
// topology-authoring fields (control-plane layout, heavy forwarders, placement).
// =============================================================================

const distributedBody = (over: Record<string, unknown> = {}) => ({
  name: 'Prod',
  deploymentType: 'distributed',
  hosting_type: 'AWS',
  region: 'us-east-1',
  cloudProviderId: 'cp-1',
  indexerCount: 4,
  searchHeadCount: 2,
  ...over,
})

describe('readByol — required + basic coercion', () => {
  it('rejects a missing name', () => {
    expect(readByol({}).error).toMatch(/Name is required/)
  })

  it('defaults single-instance topology fields', () => {
    const { data } = readByol({ name: 'Dev', deploymentType: 'single', indexerCount: 1, searchHeadCount: 1 })
    expect(data.controlPlaneLayout).toBe('dedicated')
    expect(data.heavyForwarderCount).toBe(1)
    expect(data.indexerPlacement).toBeNull()
    expect(data.searchHeadPlacement).toBeNull()
  })
})

describe('readByol — distributed guardrails', () => {
  it('requires at least 3 indexers / 2 search heads', () => {
    expect(readByol(distributedBody({ indexerCount: 2 })).error).toMatch(/at least 3 indexers/)
    expect(readByol(distributedBody({ searchHeadCount: 1 })).error).toMatch(/at least 2 search heads/)
  })
})

describe('readByol — control plane + forwarders', () => {
  it('normalizes the control-plane layout and keeps a valid one', () => {
    expect(readByol(distributedBody({ controlPlaneLayout: 'consolidated' })).data.controlPlaneLayout).toBe('consolidated')
    expect(readByol(distributedBody({ controlPlaneLayout: 'bogus' })).data.controlPlaneLayout).toBe('dedicated')
  })

  it('clamps the heavy forwarder count to a minimum of one', () => {
    expect(readByol(distributedBody({ heavyForwarderCount: 3 })).data.heavyForwarderCount).toBe(3)
    expect(readByol(distributedBody({ heavyForwarderCount: 0 })).data.heavyForwarderCount).toBe(1)
  })
})

describe('readByol — placement', () => {
  it('accepts a valid multi-site indexer placement', () => {
    const { data, error } = readByol(
      distributedBody({
        indexerCount: 4,
        indexerPlacement: { mode: 'multi-site', granularity: 'az', sites: [
          { site: 'us-east-1a', percent: 50 },
          { site: 'us-east-1b', percent: 50 },
        ] },
      }),
    )
    expect(error).toBeUndefined()
    expect((data.indexerPlacement as any).mode).toBe('multi-site')
  })

  it('rejects placement whose percentages do not total 100', () => {
    const { error } = readByol(
      distributedBody({
        indexerPlacement: { mode: 'multi-site', sites: [
          { site: 'us-east-1a', percent: 60 },
          { site: 'us-east-1b', percent: 30 },
        ] },
      }),
    )
    expect(error).toMatch(/Indexer placement: .*total 100/)
  })

  it('rejects more sites than nodes', () => {
    const { error } = readByol(
      distributedBody({
        searchHeadCount: 2,
        searchHeadPlacement: { mode: 'multi-site', sites: [
          { site: 'us-east-1a', percent: 34 },
          { site: 'us-east-1b', percent: 33 },
          { site: 'us-east-1c', percent: 33 },
        ] },
      }),
    )
    expect(error).toMatch(/Search head placement: .*Too many sites/)
  })

  it('drops placement entirely for a single-instance deployment', () => {
    const { data } = readByol({
      name: 'Dev',
      deploymentType: 'single',
      indexerCount: 1,
      searchHeadCount: 1,
      indexerPlacement: { mode: 'multi-site', sites: [{ site: 'a', percent: 50 }, { site: 'b', percent: 50 }] },
    })
    expect(data.indexerPlacement).toBeNull()
  })
})
