import { buildCreateBody, resolveAssignment, type ResolvedAssignment } from '../deploy'
import { assignmentKey } from '../validate'

const ROLE_ID = '62e90394-69f5-4237-9190-012177145e10'
const PRINCIPAL_ID = '071cc716-8147-4397-a5ba-b2105951cc0b'
const AU_ID = '5d107bba-d8e2-4e13-b6ae-884be90e5d1a'

const maps = {
  role: new Map([['global administrator', ROLE_ID]]),
  principal: { user: new Map([['ada lovelace', PRINCIPAL_ID]]), group: new Map(), servicePrincipal: new Map() },
  scope: { administrativeUnit: new Map([['west region', AU_ID]]), application: new Map() },
}

describe('resolveAssignment — id-aware, backward compatible with hand-typed names', () => {
  it('passes picker-stored GUIDs/scope through unchanged, without consulting any map', () => {
    const { resolved, missing } = resolveAssignment(
      { roleDefinitionId: ROLE_ID, principalId: PRINCIPAL_ID, directoryScopeId: '/' },
      maps
    )
    expect(resolved).toEqual({ roleDefinitionId: ROLE_ID, principalId: PRINCIPAL_ID, directoryScopeId: '/' })
    expect(missing).toEqual([])
  })

  it('resolves hand-typed role/principal/scope display names via the live maps', () => {
    const { resolved, missing } = resolveAssignment(
      { roleDefinitionId: 'Global Administrator', principalId: 'Ada Lovelace', directoryScopeId: 'West Region' },
      maps
    )
    expect(resolved).toEqual({
      roleDefinitionId: ROLE_ID,
      principalId: PRINCIPAL_ID,
      directoryScopeId: `/administrativeUnits/${AU_ID}`,
    })
    expect(missing).toEqual([])
  })

  it('defaults an empty scope to tenant-wide "/"', () => {
    const { resolved } = resolveAssignment({ roleDefinitionId: ROLE_ID, principalId: PRINCIPAL_ID, directoryScopeId: '' }, maps)
    expect(resolved.directoryScopeId).toBe('/')
  })

  it('collects every unresolvable reference as missing', () => {
    const { missing } = resolveAssignment(
      { roleDefinitionId: 'Ghost Role', principalId: 'Ghost User', directoryScopeId: 'Ghost Scope' },
      maps
    )
    expect(missing).toEqual(['Ghost Role', 'Ghost User', 'Ghost Scope'])
  })
})

describe('buildCreateBody', () => {
  it('builds the full resolved tuple, defaulting an empty scope to "/"', () => {
    const resolved: ResolvedAssignment = { roleDefinitionId: ROLE_ID, principalId: PRINCIPAL_ID, directoryScopeId: '' }
    expect(buildCreateBody(resolved)).toEqual({
      roleDefinitionId: ROLE_ID,
      principalId: PRINCIPAL_ID,
      directoryScopeId: '/',
    })
  })

  it('forwards an administrative-unit scope unchanged', () => {
    const resolved: ResolvedAssignment = {
      roleDefinitionId: ROLE_ID,
      principalId: PRINCIPAL_ID,
      directoryScopeId: `/administrativeUnits/${AU_ID}`,
    }
    expect(buildCreateBody(resolved).directoryScopeId).toBe(`/administrativeUnits/${AU_ID}`)
  })
})

describe('assignmentKey uses the RESOLVED tuple, so two different spellings of the same target match', () => {
  it('produces the same key whether the spec was hand-typed or picker-selected', () => {
    const fromPicker = resolveAssignment({ roleDefinitionId: ROLE_ID, principalId: PRINCIPAL_ID, directoryScopeId: '/' }, maps)
    const fromHandTyped = resolveAssignment(
      { roleDefinitionId: 'Global Administrator', principalId: 'Ada Lovelace', directoryScopeId: '/' },
      maps
    )
    expect(assignmentKey(fromPicker.resolved)).toBe(assignmentKey(fromHandTyped.resolved))
  })
})
