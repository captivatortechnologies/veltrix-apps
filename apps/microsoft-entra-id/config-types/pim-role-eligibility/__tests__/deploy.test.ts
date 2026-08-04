import { resolveEligibilitySpec, buildRequestBody } from '../deploy'
import { extractEligibilitySpecs } from '../validate'

const ROLE_ID = '62e90394-69f5-4237-9190-012177145e10'
const PRINCIPAL_ID = '071cc716-8147-4397-a5ba-b2105951cc0b'
const AU_ID = '5d107bba-d8e2-4e13-b6ae-884be90e5d1a'

const maps = {
  role: new Map([['global administrator', ROLE_ID]]),
  principal: { user: new Map([['ada lovelace', PRINCIPAL_ID]]), group: new Map(), servicePrincipal: new Map() },
  scope: { administrativeUnit: new Map([['west region', AU_ID]]), application: new Map() },
}

function spec(fields: Record<string, unknown>) {
  return extractEligibilitySpecs({ items: [{ fields }] } as never)[0]
}

describe('resolveEligibilitySpec — id-aware, backward compatible with hand-typed names', () => {
  it('passes picker-stored GUIDs/scope through unchanged, without consulting any map', () => {
    const { resolved, missing } = resolveEligibilitySpec(
      spec({ principalId: PRINCIPAL_ID, roleDefinitionId: ROLE_ID, directoryScopeId: '/', justification: 'x' }),
      maps
    )
    expect(resolved.principalId).toBe(PRINCIPAL_ID)
    expect(resolved.roleDefinitionId).toBe(ROLE_ID)
    expect(resolved.directoryScopeId).toBe('/')
    expect(missing).toEqual([])
  })

  it('resolves hand-typed principal/role/scope display names via the live maps', () => {
    const { resolved, missing } = resolveEligibilitySpec(
      spec({ principalId: 'Ada Lovelace', roleDefinitionId: 'Global Administrator', directoryScopeId: 'West Region', justification: 'x' }),
      maps
    )
    expect(resolved.principalId).toBe(PRINCIPAL_ID)
    expect(resolved.roleDefinitionId).toBe(ROLE_ID)
    expect(resolved.directoryScopeId).toBe(`/administrativeUnits/${AU_ID}`)
    expect(missing).toEqual([])
  })

  it('leaves non-reference fields (justification, ticketing, expiration) untouched', () => {
    const { resolved } = resolveEligibilitySpec(
      spec({
        principalId: PRINCIPAL_ID,
        roleDefinitionId: ROLE_ID,
        justification: 'privileged access',
        ticketNumber: 'CHG123',
        expirationType: 'afterDuration',
        duration: 'P30D',
      }),
      maps
    )
    expect(resolved.justification).toBe('privileged access')
    expect(resolved.ticketNumber).toBe('CHG123')
    expect(resolved.expirationType).toBe('afterDuration')
    expect(resolved.duration).toBe('P30D')
  })

  it('collects every unresolvable reference as missing', () => {
    const { missing } = resolveEligibilitySpec(
      spec({ principalId: 'Ghost User', roleDefinitionId: 'Ghost Role', directoryScopeId: 'Ghost Scope', justification: 'x' }),
      maps
    )
    expect(missing).toEqual(['Ghost Role', 'Ghost User', 'Ghost Scope'])
  })
})

describe('buildRequestBody uses the resolved tuple', () => {
  it('builds an adminAssign body carrying the resolved ids/scope', () => {
    const body = buildRequestBody(
      'adminAssign',
      { principalId: PRINCIPAL_ID, roleDefinitionId: ROLE_ID, directoryScopeId: `/administrativeUnits/${AU_ID}`, justification: 'x', ticketNumber: '', ticketSystem: '' },
      { type: 'noExpiration' }
    )
    expect(body.principalId).toBe(PRINCIPAL_ID)
    expect(body.roleDefinitionId).toBe(ROLE_ID)
    expect(body.directoryScopeId).toBe(`/administrativeUnits/${AU_ID}`)
  })
})
