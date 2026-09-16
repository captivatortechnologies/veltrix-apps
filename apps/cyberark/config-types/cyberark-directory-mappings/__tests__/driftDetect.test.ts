import driftDetect from '../driftDetect'
import { LOGON, driftContext, item, named, pvwaError, recordFetch, vendorCalls } from '../../lib/__tests__/fakePvwa'

const MAPPING = item('Mapping 1', {
  directory_name: 'CorpAD',
  mapping_name: 'Vault Admins',
  domain_groups: ['CN=VaultAdmins,OU=Groups,DC=corp,DC=example,DC=com'],
  vault_groups: ['Vault Admins'],
  mapping_authorizations: ['AddUpdateUsers'],
})

const DIRECTORIES = named('Directories', [{ DirectoryName: 'CorpAD', id: 4 }])

const IN_SYNC = {
  MappingID: 21,
  MappingName: 'Vault Admins',
  DomainGroups: ['CN=VaultAdmins,OU=Groups,DC=corp,DC=example,DC=com'],
  VaultGroups: ['Vault Admins'],
  MappingAuthorizations: ['AddUpdateUsers'],
  Location: '\\',
  DisableUser: false,
}

describe('CyberArk Directory Mappings Drift Detect Handler', () => {
  it('reports no drift and calls nothing when no credential is configured', async () => {
    const fake = recordFetch([])
    try {
      const result = await driftDetect(driftContext([MAPPING], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports no drift when the live mapping matches the deployed config', async () => {
    const fake = recordFetch([LOGON, DIRECTORIES, named('Mappings', [IN_SYNC])])
    try {
      const result = await driftDetect(driftContext([MAPPING]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('compares list fields order-independently', async () => {
    const reordered = { ...IN_SYNC, MappingAuthorizations: ['AddUpdateUsers'], VaultGroups: ['Vault Admins'] }
    const twoGroups = item('Mapping 1', {
      ...MAPPING.fields,
      mapping_authorizations: ['ManageServerFileCategories', 'AddUpdateUsers'],
    })
    const fake = recordFetch([
      LOGON,
      DIRECTORIES,
      named('Mappings', [{ ...reordered, MappingAuthorizations: ['AddUpdateUsers', 'ManageServerFileCategories'] }]),
    ])
    try {
      const result = await driftDetect(driftContext([twoGroups]))

      expect(result.hasDrift).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('reports a deleted mapping as critical drift', async () => {
    const fake = recordFetch([LOGON, DIRECTORIES, named('Mappings', [])])
    try {
      const result = await driftDetect(driftContext([MAPPING]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fake.restore()
    }
  })

  it('reports a deleted LDAP directory distinctly from a deleted mapping', async () => {
    const fake = recordFetch([LOGON, named('Directories', [])])
    try {
      const result = await driftDetect(driftContext([MAPPING]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].actual).toBe('directory missing')
      expect(result.diffs[0].severity).toBe('critical')
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports a widened authorization set as warning drift', async () => {
    const fake = recordFetch([
      LOGON,
      DIRECTORIES,
      named('Mappings', [{ ...IN_SYNC, MappingAuthorizations: ['AddUpdateUsers', 'ManageDirectoryMapping'] }]),
    ])
    try {
      const result = await driftDetect(driftContext([MAPPING]))

      const diff = result.diffs.find((d) => d.field === 'Vault Admins @ CorpAD.mapping_authorizations')
      expect(diff?.severity).toBe('warning')
      expect(String(diff?.actual)).toMatch('ManageDirectoryMapping')
    } finally {
      fake.restore()
    }
  })

  it('reports a domain group swapped outside Veltrix as warning drift', async () => {
    const fake = recordFetch([
      LOGON,
      DIRECTORIES,
      named('Mappings', [{ ...IN_SYNC, DomainGroups: ['CN=Everyone,OU=Groups,DC=corp,DC=example,DC=com'] }]),
    ])
    try {
      const result = await driftDetect(driftContext([MAPPING]))

      const diff = result.diffs.find((d) => d.field === 'Vault Admins @ CorpAD.domain_groups')
      expect(diff?.severity).toBe('warning')
      expect(String(diff?.actual)).toMatch('CN=Everyone')
    } finally {
      fake.restore()
    }
  })

  it('reports PVWA being unreachable as critical drift rather than throwing', async () => {
    const fake = recordFetch([LOGON, DIRECTORIES, pvwaError(500, 'PVWA is down')])
    try {
      const result = await driftDetect(driftContext([MAPPING]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('cyberark')
      expect(String(result.diffs[0].actual)).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
