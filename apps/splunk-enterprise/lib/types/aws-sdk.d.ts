// Minimal ambient declaration for the parts of the AWS SDK v2 that the Splunk
// Enterprise app uses server-side (presigned S3 URLs). `aws-sdk` is provided by
// the Veltrix platform runtime (see server/package.json), not this app's own
// node_modules, so this shim keeps `tsc --noEmit` green without vendoring the
// full SDK types. Credentials are resolved from the EC2 instance profile.
declare module 'aws-sdk' {
  interface S3PresignParams {
    Bucket: string
    Key: string
    ContentType?: string
    Expires?: number
  }

  interface S3ObjectParams {
    Bucket: string
    Key: string
  }

  export class S3 {
    constructor(options?: { region?: string; signatureVersion?: string; [key: string]: unknown })
    getSignedUrlPromise(operation: 'putObject' | 'getObject', params: S3PresignParams): Promise<string>
    deleteObject(params: S3ObjectParams): { promise(): Promise<unknown> }
    headObject(params: S3ObjectParams): { promise(): Promise<unknown> }
  }
}
