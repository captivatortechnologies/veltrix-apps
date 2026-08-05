import { buildAcsRolePayload, buildAcsRoleRestorePayload, toAcsRoleRollbackPrior, acsRolePath } from '../acsRoles'
import type { RoleSpec } from '../validate'

function makeSpec(overrides: Partial<RoleSpec> = {}): RoleSpec {
  return {
    sectionName: 'sec1',
    name: 'soc-analyst',
    quotas: {},
    transport: 'acs',
    searchHeadTargets: [],
    ...overrides,
  }
}

describe('acsRolePath', () => {
  it('URL-encodes the role name', () => {
    expect(acsRolePath('soc analyst')).toBe('/roles/soc%20analyst')
  })
})

describe('buildAcsRolePayload', () => {
  it('includes only declared fields, using ACS camelCase key names', () => {
    const spec = makeSpec({
      importedRoles: ['user'],
      capabilities: ['search'],
      srchFilter: 'host=web*',
      quotas: { srchJobsQuota: 5, cumulativeSrchJobsQuota: 0 },
    })
    expect(buildAcsRolePayload(spec)).toEqual({
      importedRoles: ['user'],
      capabilities: ['search'],
      srchFilter: 'host=web*',
      srchJobsQuota: 5,
      cumulativeSrchJobsQuota: 0,
    })
  })

  it('omits fields the canvas left blank entirely (no key at all)', () => {
    const spec = makeSpec({ capabilities: ['search'] })
    const payload = buildAcsRolePayload(spec)
    expect(payload).toEqual({ capabilities: ['search'] })
    expect('importedRoles' in payload).toBe(false)
    expect('srchFilter' in payload).toBe(false)
  })
})

describe('toAcsRoleRollbackPrior / buildAcsRoleRestorePayload round-trip', () => {
  it('captures importedRoles from the nested `imported.roles` field and restores it as a top-level write', () => {
    const prior = toAcsRoleRollbackPrior({
      name: 'soc-analyst',
      capabilities: ['search'],
      imported: { roles: ['user'] },
      srchTimeWin: -1,
    })
    expect(prior).toEqual({ capabilities: ['search'], importedRoles: ['user'], srchTimeWin: -1 })

    const restore = buildAcsRoleRestorePayload(prior)
    expect(restore).toEqual({ capabilities: ['search'], importedRoles: ['user'], srchTimeWin: -1 })
  })

  it('restores a previously-empty list as an explicit empty array (ACS lists are wholesale-replaced)', () => {
    const restore = buildAcsRoleRestorePayload({ capabilities: [] })
    expect(restore).toEqual({ capabilities: [] })
  })

  it('omits a key entirely when it was never captured', () => {
    const restore = buildAcsRoleRestorePayload({ srchFilter: 'host=web*' })
    expect('capabilities' in restore).toBe(false)
    expect(restore.srchFilter).toBe('host=web*')
  })
})
