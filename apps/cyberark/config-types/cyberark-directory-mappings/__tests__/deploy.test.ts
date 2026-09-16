import deploy from '../deploy'
import {
  API_URL,
  LOGON,
  LOGON_TOKEN,
  bodyOf,
  created,
  deployContext,
  isLogon,
  item,
  named,
  ok,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const MAPPING = item('Mapping 1', {
  directory_name: 'CorpAD',
  mapping_name: 'Vault Admins',
  domain_groups: ['CN=VaultAdmins,OU=Groups,DC=corp,DC=example,DC=com'],
  vault_groups: ['Vault Admins'],
  mapping_authorizations: ['AddUpdateUsers', 'ManageServerFileCategories'],
  ldap_branch: 'OU=Groups,DC=corp,DC=example,DC=com',
  user_type: 'EPVUser',
})

const DIRECTORIES = named('Directories', [{ DirectoryName: 'CorpAD', id: 4 }])

const LIVE_MAPPING = {
  MappingID: 21,
  MappingName: 'Vault Admins',
  DomainGroups: ['CN=Old,OU=Groups,DC=corp,DC=example,DC=com'],
  VaultGroups: ['Vault Admins'],
  MappingAuthorizations: ['AddUpdateUsers'],
  Location: '\\',
  UserType: 'EPVUser',
}

describe('CyberArk Directory Mappings Deploy Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await deploy(deployContext([MAPPING], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('logs on before the first resource call and sends the raw session token', async () => {
    const fake = recordFetch([LOGON, DIRECTORIES, named('Mappings', []), created({ MappingID: 21 })])
    try {
      await deploy(deployContext([MAPPING]))

      expect(isLogon(fake.calls[0])).toBe(true)
      expect(fake.calls[0].authorization).toBeNull()
      expect(vendorCalls(fake.calls)[0].authorization).toBe(LOGON_TOKEN)
    } finally {
      fake.restore()
    }
  })

  it('creates a mapping that does not exist yet, under the resolved directory id', async () => {
    const fake = recordFetch([LOGON, DIRECTORIES, named('Mappings', []), created({ MappingID: 21 })])
    try {
      const result = await deploy(deployContext([MAPPING]))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/Configuration/LDAP/Directories/`)
      expect(calls[1].url).toBe(`${API_URL}/Configuration/LDAP/Directories/4/Mappings`)

      const create = calls[2]
      expect(create.method).toBe('POST')
      expect(create.url).toBe(`${API_URL}/Configuration/LDAP/Directories/4/Mappings/`)

      const body = bodyOf(create) as Record<string, unknown>
      expect(body.MappingName).toBe('Vault Admins')
      expect(body.DomainGroups).toEqual(['CN=VaultAdmins,OU=Groups,DC=corp,DC=example,DC=com'])
      expect(body.MappingAuthorizations).toEqual(['AddUpdateUsers', 'ManageServerFileCategories'])
      expect(body.LDAPBranch).toBe('OU=Groups,DC=corp,DC=example,DC=com')
      // A create must not claim a MappingID it does not have yet.
      expect(body.MappingID).toBeUndefined()

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; directoryId: string; mappingId?: string }>
      }
      expect(rollbackData.previousState[0].existed).toBe(false)
      expect(rollbackData.previousState[0].directoryId).toBe('4')
      expect(rollbackData.previousState[0].mappingId).toBe('21')
    } finally {
      fake.restore()
    }
  })

  it('replaces an existing mapping in full and captures what it replaced', async () => {
    const fake = recordFetch([LOGON, DIRECTORIES, named('Mappings', [LIVE_MAPPING]), ok()])
    try {
      const result = await deploy(deployContext([MAPPING]))

      const update = vendorCalls(fake.calls)[2]
      expect(update.method).toBe('PUT')
      expect(update.url).toBe(`${API_URL}/Configuration/LDAP/Directories/4/Mappings/21`)

      const body = bodyOf(update) as Record<string, unknown>
      // The PUT is a FULL replace, so every managed field must be present.
      expect(body.MappingID).toBe(21)
      expect(body.DomainGroups).toEqual(['CN=VaultAdmins,OU=Groups,DC=corp,DC=example,DC=com'])
      expect(body.MappingAuthorizations).toEqual(['AddUpdateUsers', 'ManageServerFileCategories'])
      expect(body.DisableUser).toBe(false)

      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; prior?: { DomainGroups?: string[]; MappingAuthorizations?: string[] } }>
      }
      expect(rollbackData.previousState[0].existed).toBe(true)
      expect(rollbackData.previousState[0].prior?.DomainGroups).toEqual(['CN=Old,OU=Groups,DC=corp,DC=example,DC=com'])
      expect(rollbackData.previousState[0].prior?.MappingAuthorizations).toEqual(['AddUpdateUsers'])
    } finally {
      fake.restore()
    }
  })

  it('refuses to create the LDAP directory it was pointed at', async () => {
    const fake = recordFetch([LOGON, named('Directories', [{ DirectoryName: 'OtherAD', id: 5 }])])
    try {
      const result = await deploy(deployContext([MAPPING]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('LDAP directory "CorpAD" was not found')
      expect(result.message).toMatch('never the directory connection itself')
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('resolves the directory once when several mappings share it', async () => {
    const second = item('Mapping 2', {
      directory_name: 'CorpAD',
      mapping_name: 'Vault Auditors',
      domain_groups: ['CN=VaultAuditors,OU=Groups,DC=corp,DC=example,DC=com'],
    })
    const fake = recordFetch([LOGON, DIRECTORIES, named('Mappings', []), created({ MappingID: 21 }), created({ MappingID: 22 })])
    try {
      const result = await deploy(deployContext([MAPPING, second]))

      const lists = vendorCalls(fake.calls).filter((c) => c.url === `${API_URL}/Configuration/LDAP/Directories/`)
      expect(lists).toHaveLength(1)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the create', async () => {
    const fake = recordFetch([LOGON, DIRECTORIES, named('Mappings', []), pvwaError(400, 'Mapping name already in use')])
    try {
      const result = await deploy(deployContext([MAPPING]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Mapping name already in use')
      expect(result.message).toMatch(/0 of 1/)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when the mapping list itself fails', async () => {
    const fake = recordFetch([LOGON, DIRECTORIES, pvwaError(403, 'Not authorized to read mappings')])
    try {
      const result = await deploy(deployContext([MAPPING]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to read mappings')
    } finally {
      fake.restore()
    }
  })

  it('skips a mapping that declares no domain group rather than granting nothing', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await deploy(
        deployContext([item('Mapping 1', { directory_name: 'CorpAD', mapping_name: 'Vault Admins' })]),
      )

      expect(result.success).toBe(true)
      expect(vendorCalls(fake.calls)).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })
})
