import { isGuid, resolveRef, resolveRefs, resolveAcrossMaps, resolveAcrossMapsMany } from '../nameMaps'

describe('isGuid', () => {
  it('accepts a standard GUID, case-insensitively', () => {
    expect(isGuid('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(true)
    expect(isGuid('3FA85F64-5717-4562-B3FC-2C963F66AFA6')).toBe(true)
  })

  it('rejects a display name or a malformed id', () => {
    expect(isGuid('Global Administrator')).toBe(false)
    expect(isGuid('3fa85f64-5717-4562-b3fc')).toBe(false)
    expect(isGuid('')).toBe(false)
  })
})

describe('resolveRef — GUID passthrough, else name resolution', () => {
  const ROLE_ID = '62e90394-69f5-4237-9190-012177145e10'
  const nameToId = new Map([['global administrator', ROLE_ID]])

  it('treats an empty value as unset, not missing', () => {
    expect(resolveRef('', new Map())).toEqual({ id: '', missing: false })
  })

  it('passes a picker-stored GUID through unchanged, without consulting the name map', () => {
    expect(resolveRef(ROLE_ID, new Map())).toEqual({ id: ROLE_ID, missing: false })
  })

  it('resolves a hand-typed display name via the live map', () => {
    expect(resolveRef('Global Administrator', nameToId)).toEqual({ id: ROLE_ID, missing: false })
  })

  it('reports an unresolved name as missing', () => {
    expect(resolveRef('Ghost Role', nameToId)).toEqual({ id: '', missing: true })
  })
})

describe('resolveRefs — batch form', () => {
  const nameToId = new Map([
    ['engineering', 'g-1'],
    ['sales', 'g-2'],
  ])

  it('mixes picker ids and hand-typed names, collecting missing ones separately', () => {
    const r = resolveRefs(['3fa85f64-5717-4562-b3fc-2c963f66afa6', 'Engineering', 'Ghost Group'], nameToId)
    expect(r.ids).toEqual(['3fa85f64-5717-4562-b3fc-2c963f66afa6', 'g-1'])
    expect(r.missing).toEqual(['Ghost Group'])
  })
})

describe('resolveAcrossMaps — priority-ordered multi-map resolution', () => {
  const GUID = '11111111-1111-1111-1111-111111111111'
  const userMap = new Map([['ops', 'u-ops']])
  const groupMap = new Map([['ops', 'g-ops']])
  const spMap = new Map([['ops-app', 'sp-ops']])

  it('passes a GUID through without checking any map', () => {
    expect(resolveAcrossMaps(GUID, [userMap, groupMap])).toEqual({ id: GUID, missing: false })
  })

  it('treats an empty value as unset', () => {
    expect(resolveAcrossMaps('', [userMap])).toEqual({ id: '', missing: false })
  })

  it('resolves against the first map that has the name', () => {
    expect(resolveAcrossMaps('ops-app', [userMap, groupMap, spMap])).toEqual({ id: 'sp-ops', missing: false })
  })

  it('a name colliding across maps resolves to whichever map is checked first', () => {
    expect(resolveAcrossMaps('ops', [userMap, groupMap])).toEqual({ id: 'u-ops', missing: false })
    expect(resolveAcrossMaps('ops', [groupMap, userMap])).toEqual({ id: 'g-ops', missing: false })
  })

  it('reports an unresolved name as missing', () => {
    expect(resolveAcrossMaps('Ghost', [userMap, groupMap, spMap])).toEqual({ id: '', missing: true })
  })
})

describe('resolveAcrossMapsMany — batch form', () => {
  const userMap = new Map([['ada lovelace', 'u-1']])
  const groupMap = new Map([['engineering', 'g-1']])
  const deviceMap = new Map([["ada's laptop", 'd-1']])

  it('resolves a mix of kinds in one call and collects missing separately', () => {
    const r = resolveAcrossMapsMany(['Ada Lovelace', 'Engineering', "Ada's Laptop", 'Ghost'], [userMap, groupMap, deviceMap])
    expect(r.ids).toEqual(['u-1', 'g-1', 'd-1'])
    expect(r.missing).toEqual(['Ghost'])
  })
})
