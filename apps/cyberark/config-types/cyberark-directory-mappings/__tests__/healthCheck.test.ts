import healthCheck from '../healthCheck'
import { API_URL, LOGON, healthContext, item, named, pvwaError, recordFetch, vendorCalls } from '../../lib/__tests__/fakePvwa'

const MAPPINGS = [
  item('Mapping 1', { directory_name: 'CorpAD', mapping_name: 'Vault Admins', domain_groups: ['CN=A'] }),
  item('Mapping 2', { directory_name: 'CorpAD', mapping_name: 'Vault Auditors', domain_groups: ['CN=B'] }),
]

const DIRECTORIES = named('Directories', [{ DirectoryName: 'CorpAD', id: 4 }])

describe('CyberArk Directory Mappings Health Check Handler', () => {
  it('fails closed without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await healthCheck(healthContext(MAPPINGS, { credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('cyberark_credential')
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('scores 100 when every declared mapping is present', async () => {
    const fake = recordFetch([
      LOGON,
      DIRECTORIES,
      named('Mappings', [
        { MappingID: 21, MappingName: 'Vault Admins' },
        { MappingID: 22, MappingName: 'Vault Auditors' },
      ]),
    ])
    try {
      const result = await healthCheck(healthContext(MAPPINGS))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      // Both mappings live under the same directory — one list covers both.
      expect(vendorCalls(fake.calls)).toHaveLength(2)
      expect(vendorCalls(fake.calls)[1].url).toBe(`${API_URL}/Configuration/LDAP/Directories/4/Mappings`)
    } finally {
      fake.restore()
    }
  })

  it('reports the specific mapping that has gone missing', async () => {
    const fake = recordFetch([LOGON, DIRECTORIES, named('Mappings', [{ MappingID: 21, MappingName: 'Vault Admins' }])])
    try {
      const result = await healthCheck(healthContext(MAPPINGS))

      expect(result.healthy).toBe(false)
      const missing = result.checks.find((c) => c.name === 'mapping:Vault Auditors@CorpAD')
      expect(missing?.passed).toBe(false)
      expect(missing?.message).toMatch('missing')
    } finally {
      fake.restore()
    }
  })

  it('fails the reachability check when the directory itself is gone', async () => {
    const fake = recordFetch([LOGON, named('Directories', [])])
    try {
      const result = await healthCheck(healthContext(MAPPINGS))

      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('cyberark_reachable')
      expect(result.checks[0].message).toMatch('LDAP directory "CorpAD" was not found')
    } finally {
      fake.restore()
    }
  })

  it('reports a failed reachability check rather than throwing when PVWA errors', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await healthCheck(healthContext(MAPPINGS))

      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
