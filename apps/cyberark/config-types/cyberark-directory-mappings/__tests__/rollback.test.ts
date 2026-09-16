import rollback from '../rollback'
import type { DirectoryMappingRollbackEntry } from '../deploy'
import {
  API_URL,
  LOGON,
  bodyOf,
  ok,
  pvwaError,
  recordFetch,
  rollbackContext,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const CREATED: DirectoryMappingRollbackEntry = {
  key: '["corpad","vault admins"]',
  label: 'Vault Admins @ CorpAD',
  directoryId: '4',
  existed: false,
  mappingId: '21',
}

const UPDATED: DirectoryMappingRollbackEntry = {
  key: '["corpad","vault auditors"]',
  label: 'Vault Auditors @ CorpAD',
  directoryId: '4',
  existed: true,
  mappingId: '22',
  prior: {
    MappingID: 22,
    MappingName: 'Vault Auditors',
    DomainGroups: ['CN=Old,OU=Groups,DC=corp,DC=example,DC=com'],
    VaultGroups: ['Auditors'],
    MappingAuthorizations: ['AuditUsers'],
    Location: '\\',
    UserType: 'EPVUser',
    DisableUser: false,
  },
}

describe('CyberArk Directory Mappings Rollback Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }, { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('refuses when the deployment recorded no previous state', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/No previous state/)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('deletes a mapping this deploy created', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].url).toBe(`${API_URL}/Configuration/LDAP/Directories/4/Mappings/21/`)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('restores the prior authorizations of a mapping this deploy replaced', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [UPDATED] }))

      const restore = vendorCalls(fake.calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.url).toBe(`${API_URL}/Configuration/LDAP/Directories/4/Mappings/22`)

      const body = bodyOf(restore) as Record<string, unknown>
      expect(body.MappingID).toBe(22)
      expect(body.DomainGroups).toEqual(['CN=Old,OU=Groups,DC=corp,DC=example,DC=com'])
      expect(body.MappingAuthorizations).toEqual(['AuditUsers'])
      expect(body.VaultGroups).toEqual(['Auditors'])
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('unwinds in reverse deploy order', async () => {
    const fake = recordFetch([LOGON, ok(), ok()])
    try {
      await rollback(rollbackContext({ previousState: [CREATED, UPDATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toMatch('/Mappings/22')
      expect(calls[1].url).toMatch('/Mappings/21/')
    } finally {
      fake.restore()
    }
  })

  it('treats an already-deleted mapping (404) as successfully rolled back', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'Mapping not found')])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the restore', async () => {
    const fake = recordFetch([LOGON, pvwaError(403, 'Not authorized to update mappings')])
    try {
      const result = await rollback(rollbackContext({ previousState: [UPDATED] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to update mappings')
    } finally {
      fake.restore()
    }
  })

  it('skips a created mapping whose MappingID was never returned', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await rollback(rollbackContext({ previousState: [{ ...CREATED, mappingId: undefined }] }))

      expect(vendorCalls(fake.calls)).toHaveLength(0)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })
})
