import { isGuid, resolveGroups, buildPolicyBody } from '../deploy'
import type { CaPolicySpec } from '../validate'

describe('isGuid', () => {
  it('accepts a standard GUID, case-insensitively', () => {
    expect(isGuid('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(true)
    expect(isGuid('3FA85F64-5717-4562-B3FC-2C963F66AFA6')).toBe(true)
  })

  it('rejects a display name or a malformed id', () => {
    expect(isGuid('Engineering')).toBe(false)
    expect(isGuid('3fa85f64-5717-4562-b3fc')).toBe(false)
    expect(isGuid('')).toBe(false)
  })
})

describe('resolveGroups — id-aware, backward compatible with hand-typed names', () => {
  const GROUP_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
  const nameToId = new Map([
    ['engineering', 'g-1'],
    ['sales', 'g-2'],
  ])

  it('passes a picker-stored GUID through unchanged, without consulting the name map', () => {
    const r = resolveGroups([GROUP_ID], new Map())
    expect(r.ids).toEqual([GROUP_ID])
    expect(r.missing).toEqual([])
  })

  it('still resolves a hand-typed display name via the live map (pre-picker behavior)', () => {
    const r = resolveGroups(['Engineering'], nameToId)
    expect(r.ids).toEqual(['g-1'])
    expect(r.missing).toEqual([])
  })

  it('mixes picker ids and hand-typed names in the same field', () => {
    const r = resolveGroups([GROUP_ID, 'Sales'], nameToId)
    expect(r.ids).toEqual([GROUP_ID, 'g-2'])
    expect(r.missing).toEqual([])
  })

  it('reports an unresolved name as missing, same as before the picker existed', () => {
    const r = resolveGroups(['Ghost Group'], nameToId)
    expect(r.ids).toEqual([])
    expect(r.missing).toEqual(['Ghost Group'])
  })
})

describe('buildPolicyBody — includeApps is passed through as-is (already id/keyword based)', () => {
  const base: CaPolicySpec = {
    name: 'P',
    state: 'report-only',
    includeAllUsers: false,
    includeGroups: [],
    excludeGroups: [],
    includeAllApps: false,
    includeApps: [],
    grantOperator: 'OR',
    builtInControls: ['mfa'],
  }

  it('forwards a picker-selected appId unchanged', () => {
    const body = buildPolicyBody({ ...base, includeApps: ['00000003-0000-0000-c000-000000000000'] }, [], [])
    expect((body.conditions as { applications: { includeApplications: string[] } }).applications.includeApplications).toEqual([
      '00000003-0000-0000-c000-000000000000',
    ])
  })

  it('forwards a picker-selected sentinel keyword unchanged', () => {
    const body = buildPolicyBody({ ...base, includeApps: ['MicrosoftAdminPortals'] }, [], [])
    expect((body.conditions as { applications: { includeApplications: string[] } }).applications.includeApplications).toEqual([
      'MicrosoftAdminPortals',
    ])
  })
})
