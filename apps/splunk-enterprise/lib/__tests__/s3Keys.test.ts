import { packageKey, toS3Uri, parseS3Uri, packagesBucket, uploadsEnabled } from '../s3Keys'

describe('s3Keys.packageKey', () => {
  it('builds a tenant-partitioned key', () => {
    expect(packageKey('cust1', 'ver1', 'splunk-10.4.2-linux-amd64.tgz')).toBe(
      'versions/cust1/ver1/splunk-10.4.2-linux-amd64.tgz',
    )
  })

  it('sanitizes unsafe filename characters', () => {
    expect(packageKey('c', 'v', 'my file@!.tgz')).toBe('versions/c/v/my_file__.tgz')
  })

  it('falls back to "package" for an empty filename', () => {
    expect(packageKey('c', 'v', '')).toBe('versions/c/v/package')
  })
})

describe('s3Keys.toS3Uri / parseS3Uri', () => {
  it('round-trips a bucket + key', () => {
    const uri = toS3Uri('my-bucket', 'versions/c/v/file.tgz')
    expect(uri).toBe('s3://my-bucket/versions/c/v/file.tgz')
    expect(parseS3Uri(uri)).toEqual({ bucket: 'my-bucket', key: 'versions/c/v/file.tgz' })
  })

  it('returns null for an http(s) URL', () => {
    expect(parseS3Uri('https://download.splunk.com/splunk-10.4.2.tgz')).toBe(null)
  })

  it('returns null for null or empty input', () => {
    expect(parseS3Uri(null)).toBe(null)
    expect(parseS3Uri('')).toBe(null)
  })

  it('returns null when there is no key segment', () => {
    expect(parseS3Uri('s3://only-bucket')).toBe(null)
  })
})

describe('s3Keys.packagesBucket / uploadsEnabled', () => {
  it('reflects the SPLUNK_PACKAGES_BUCKET env var', () => {
    const original = process.env.SPLUNK_PACKAGES_BUCKET
    try {
      delete process.env.SPLUNK_PACKAGES_BUCKET
      expect(packagesBucket()).toBe(null)
      expect(uploadsEnabled()).toBe(false)

      process.env.SPLUNK_PACKAGES_BUCKET = 'veltrix-dev-splunk-packages'
      expect(packagesBucket()).toBe('veltrix-dev-splunk-packages')
      expect(uploadsEnabled()).toBe(true)

      // Whitespace-only is treated as unset.
      process.env.SPLUNK_PACKAGES_BUCKET = '   '
      expect(packagesBucket()).toBe(null)
    } finally {
      if (original === undefined) delete process.env.SPLUNK_PACKAGES_BUCKET
      else process.env.SPLUNK_PACKAGES_BUCKET = original
    }
  })
})
