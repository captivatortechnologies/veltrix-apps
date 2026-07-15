import { readVersion } from '../versionInput'

describe('readVersion', () => {
  it('requires a version', () => {
    expect(readVersion({}).error).toBe('Version is required')
  })

  it('rejects invalid version characters', () => {
    expect(readVersion({ version: 'v 1' }).error).toMatch(/must start with a digit/)
  })

  it('rejects a version longer than 40 characters', () => {
    expect(readVersion({ version: '1'.repeat(41) }).error).toBe('Version must be 40 characters or fewer')
  })

  it('rejects a non-http(s) download URL', () => {
    expect(readVersion({ version: '10.0.0', downloadUrl: 's3://bucket/key' }).error).toBe(
      'Download URL must be an http(s) URL',
    )
  })

  it('rejects an invalid release date', () => {
    expect(readVersion({ version: '10.0.0', releaseDate: 'nope' }).error).toBe('Release date is invalid')
  })

  it('coerces a valid payload and trims fields', () => {
    const { data, error } = readVersion({
      version: '10.4.2',
      downloadUrl: '  https://download.splunk.com/x.tgz  ',
      releaseNotes: '  notes  ',
      isLatest: 'true',
      isActive: false,
    })
    expect(error).toBeUndefined()
    expect(data.version).toBe('10.4.2')
    expect(data.downloadUrl).toBe('https://download.splunk.com/x.tgz')
    expect(data.releaseNotes).toBe('notes')
    expect(data.isLatest).toBe(true)
    expect(data.isActive).toBe(false)
  })

  it('defaults isActive true / isLatest false / downloadUrl null', () => {
    const { data } = readVersion({ version: '9.4.12' })
    expect(data.isActive).toBe(true)
    expect(data.isLatest).toBe(false)
    expect(data.downloadUrl).toBe(null)
  })
})
