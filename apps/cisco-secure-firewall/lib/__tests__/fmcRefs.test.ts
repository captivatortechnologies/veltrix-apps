import { resolveRefs, type RefIndex } from '../fmcRefs'

describe('fmcRefs — resolveRefs', () => {
  function index(): RefIndex {
    return new Map([
      ['web-servers', { id: 'id-1', type: 'Host', name: 'web-servers' }],
      ['corp-net', { id: 'id-2', type: 'Network', name: 'corp-net' }],
    ])
  }

  it('resolves known names case-insensitively', () => {
    const { resolved, missing } = resolveRefs(index(), ['Web-Servers', ' corp-net '])
    expect(resolved).toEqual([
      { id: 'id-1', type: 'Host', name: 'web-servers' },
      { id: 'id-2', type: 'Network', name: 'corp-net' },
    ])
    expect(missing).toEqual([])
  })

  it('reports unresolved names without throwing', () => {
    const { resolved, missing } = resolveRefs(index(), ['web-servers', 'ghost-object'])
    expect(resolved).toHaveLength(1)
    expect(missing).toEqual(['ghost-object'])
  })

  it('returns everything missing against an empty index', () => {
    const { resolved, missing } = resolveRefs(new Map(), ['a', 'b'])
    expect(resolved).toEqual([])
    expect(missing).toEqual(['a', 'b'])
  })
})
