// Minimal ambient declarations for the parts of the AWS SDK v3 the Splunk
// Enterprise app uses server-side (presigned S3 URLs + object delete). The SDK
// is provided by the Veltrix platform runtime, not this app's own node_modules
// (server-side TS is transpiled, not bundled, and node_modules is excluded from
// the package), so this shim keeps `tsc --noEmit` green without vendoring the
// full SDK types. Credentials are resolved from the default AWS credential chain
// (the EC2 instance profile in production).
declare module '@aws-sdk/client-s3' {
  export interface S3ClientConfig {
    region?: string
    [key: string]: unknown
  }

  export interface PutObjectCommandInput {
    Bucket: string
    Key: string
    ContentType?: string
  }
  export interface GetObjectCommandInput {
    Bucket: string
    Key: string
  }
  export interface DeleteObjectCommandInput {
    Bucket: string
    Key: string
  }

  export class PutObjectCommand {
    constructor(input: PutObjectCommandInput)
  }
  export class GetObjectCommand {
    constructor(input: GetObjectCommandInput)
  }
  export class DeleteObjectCommand {
    constructor(input: DeleteObjectCommandInput)
  }

  export class S3Client {
    constructor(config?: S3ClientConfig)
    send(command: unknown): Promise<unknown>
  }
}

declare module '@aws-sdk/s3-request-presigner' {
  import type { S3Client } from '@aws-sdk/client-s3'
  export function getSignedUrl(
    client: S3Client,
    command: unknown,
    options?: { expiresIn?: number },
  ): Promise<string>
}
