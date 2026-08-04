// =============================================================================
// Velociraptor access seam.
//
// One path: the Velociraptor programmatic API is gRPC over MUTUAL TLS. There is
// no REST surface — MANAGEMENT IS VQL executed over that gRPC channel. The
// credential is the "api-client config" produced by
// `velociraptor config api_client --name veltrix ...`: a YAML/PEM bundle carrying
//   ca_certificate       (PEM — pins the server's self-signed CA)
//   client_cert          (PEM — the API client's certificate)
//   client_private_key   (PEM — the API client's private key)
//   api_connection_string (host:port of the API server, e.g. localhost:8001)
//
// This module keeps the gRPC/proto transport ISOLATED behind a small, swappable
// seam (VelociraptorTransport). Everything above it — config resolution, the VQL
// query builders, row parsing — is pure and network-free. The gRPC wire contract
// lives in ./velociraptor.proto (the single swap point); adopting Velociraptor's
// canonical api.proto is a drop-in replacement there.
//
// >>> VERIFY AGAINST A LIVE VELOCIRAPTOR SERVER <<<
// Flagged below: the gRPC service/method names, the SSL target-name override, and
// the VQL function names (artifact_set / artifact_delete / artifact_definitions /
// info). None are silently assumed correct — each is marked for verification.
// =============================================================================

import path from 'node:path'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

// --- api-client config bundle --------------------------------------------------

/** The four pieces the gRPC mTLS channel needs, extracted from the api-client config. */
export interface ApiClientConfig {
  caCertificate: string
  clientCert: string
  clientPrivateKey: string
  /** host:port of the API server (from the bundle, else the connection endpoint). */
  apiConnectionString: string
}

const CONN_STRING_RE = /^\s*api_connection_string\s*:\s*["']?([^"'\r\n]+)["']?\s*$/m

/**
 * Parse the `velociraptor config api_client` YAML bundle WITHOUT a YAML dependency
 * (the platform only guarantees the SDK at runtime). The bundle's shape is fixed:
 * a handful of top-level keys, three of them PEM block scalars (`key: |`) and
 * `api_connection_string` inline. This walks top-level `key:` lines and collects
 * the indented block-scalar body for the three cert keys.
 *
 * VERIFY: key names (ca_certificate / client_cert / client_private_key /
 * api_connection_string) match the api-client config emitted by Velociraptor.
 */
export function parseApiClientBundle(raw: string): Partial<ApiClientConfig> {
  const out: Partial<ApiClientConfig> = {}
  const connMatch = CONN_STRING_RE.exec(raw)
  if (connMatch) out.apiConnectionString = connMatch[1].trim()

  const lines = raw.split(/\r?\n/)
  const targets: Record<string, keyof ApiClientConfig> = {
    ca_certificate: 'caCertificate',
    client_cert: 'clientCert',
    client_private_key: 'clientPrivateKey',
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const keyMatch = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line)
    // Only top-level (unindented) keys start a new block.
    if (keyMatch && !/^\s/.test(line)) {
      const field = targets[keyMatch[1]]
      const inline = keyMatch[2].trim()
      const isBlockScalar = inline === '|' || inline === '|-' || inline === '' || inline === '>'
      if (field && isBlockScalar) {
        const body: string[] = []
        let j = i + 1
        for (; j < lines.length; j++) {
          const bodyLine = lines[j]
          if (bodyLine.trim() === '') {
            body.push('')
            continue
          }
          if (!/^\s/.test(bodyLine)) break // dedented → block ended
          body.push(bodyLine.replace(/^\s+/, '')) // strip block indentation (PEM lines carry none of their own)
        }
        out[field] = body.join('\n').replace(/\n+$/, '').trim()
        i = j
        continue
      }
    }
    i++
  }
  return out
}

/** Raw endpoint (host:port) from the connection, used when the bundle omits it. */
function endpointFrom(component?: ComponentRef | null, connectivity?: ConnectivityRef | null): string {
  if (connectivity?.tailscaleDeviceIP && component?.port) return `${connectivity.tailscaleDeviceIP}:${component.port}`
  if (component?.hostname) return component.port ? `${component.hostname}:${component.port}` : component.hostname
  return ''
}

/**
 * Resolve the api-client config from a connection credential.
 *
 * MAPPING (see README): the whole api-client YAML bundle is stored as ONE
 * credential secret. The ConnectionsManager exposes a single secret field
 * (`apiToken`) plus the cert field (`certificate`), so the resolver accepts the
 * bundle from EITHER — whichever the platform persisted. `api_connection_string`
 * comes from the bundle first, then falls back to the connection endpoint.
 *
 * A split-field fallback is also honored for deployments that store the PEMs
 * separately: certificate = client_cert, apiToken = client_private_key,
 * password = ca_certificate.
 */
export function resolveApiClientConfig(
  credential: CredentialRef | null | undefined,
  component?: ComponentRef | null,
  connectivity?: ConnectivityRef | null,
): ApiClientConfig {
  const bundleSource = (credential?.certificate || credential?.apiToken || '').trim()
  const parsed = bundleSource ? parseApiClientBundle(bundleSource) : {}

  const caCertificate = parsed.caCertificate || credential?.password || ''
  const clientCert = parsed.clientCert || (bundleHasNoPems(parsed) ? credential?.certificate || '' : '')
  const clientPrivateKey = parsed.clientPrivateKey || (bundleHasNoPems(parsed) ? credential?.apiToken || '' : '')
  const apiConnectionString = parsed.apiConnectionString || endpointFrom(component, connectivity)

  return { caCertificate, clientCert, clientPrivateKey, apiConnectionString }
}

function bundleHasNoPems(parsed: Partial<ApiClientConfig>): boolean {
  return !parsed.caCertificate && !parsed.clientCert && !parsed.clientPrivateKey
}

/** True when all mTLS material + an endpoint are present. */
export function isApiClientConfigComplete(config: ApiClientConfig): boolean {
  return Boolean(config.caCertificate && config.clientCert && config.clientPrivateKey && config.apiConnectionString)
}

// --- VQL query builders --------------------------------------------------------

/** Connectivity/version probe. VERIFY: `info()` is a Velociraptor plugin that
 *  returns one row of server/host info; any row back == connected. */
export const INFO_VQL = 'SELECT * FROM info()'

/** Escape a string for inclusion in single-quoted VQL. VQL uses '' to escape a quote. */
export function vqlQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Render a VQL array literal of strings, e.g. ['reader', 'analyst']. */
export function vqlStringArray(values: string[]): string {
  return `[${values.map(vqlQuote).join(', ')}]`
}

/**
 * Split a newline / comma-delimited list into trimmed, de-duplicated, non-empty
 * entries. Used by the monitoring + users config types to turn a textarea of
 * artifact / role names into a clean list. Network-free.
 */
export function splitList(text: unknown): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of String(text ?? '').split(/[\r\n,]+/)) {
    const value = part.trim()
    if (value && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}

/** Coerce a checkbox/select field value to a boolean, tolerant of string/number forms. */
export function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return /^(true|1|yes|on|enabled)$/i.test(value.trim())
  return fallback
}

/**
 * Render a value as a `parse_json(data=<json>)` VQL expression — the standard way
 * this app hands a dict/array literal to a VQL function argument that expects a
 * structured value (set_client_monitoring, set_server_monitoring,
 * server_set_metadata, secret_add, user_grant's policy, ...). Centralised here so
 * every config type builds these the same way.
 */
export function vqlJson(value: unknown): string {
  return `parse_json(data=${vqlQuote(JSON.stringify(value))})`
}

/**
 * Upsert a custom artifact from its YAML definition.
 * VERIFY: `artifact_set(definition=<yaml>)` adds/updates a custom artifact keyed
 * by the `name:` inside the YAML, returning the stored definition.
 */
export function artifactSetVQL(definitionYaml: string): string {
  return `SELECT artifact_set(definition=${vqlQuote(definitionYaml)}) AS artifact FROM scope()`
}

/**
 * Delete a custom artifact by name.
 * VERIFY: `artifact_delete(name=<name>)` removes a custom artifact.
 */
export function artifactDeleteVQL(name: string): string {
  return `SELECT artifact_delete(name=${vqlQuote(name)}) AS deleted FROM scope()`
}

/**
 * List artifact definitions, optionally narrowed to specific names.
 * VERIFY: `artifact_definitions()` returns rows with at least `name` and the raw
 * source; the raw-source column name (`raw` vs `definition`) is read defensively
 * by readArtifactDefinition().
 */
export function artifactDefinitionsVQL(names?: string[]): string {
  if (names && names.length > 0) {
    const list = names.map(vqlQuote).join(', ')
    return `SELECT * FROM artifact_definitions(names=[${list}])`
  }
  return 'SELECT * FROM artifact_definitions()'
}

/** The raw YAML source of an artifact row, tolerant of the exact column name. VERIFY. */
export function readArtifactDefinition(row: VqlRow | null | undefined): string {
  if (!row) return ''
  const candidate = row['raw'] ?? row['definition'] ?? row['Raw'] ?? row['Definition']
  return typeof candidate === 'string' ? candidate : ''
}

// --- transport seam ------------------------------------------------------------

export type VqlRow = Record<string, unknown>

export interface RunVqlOptions {
  /** Max rows to request from the server (maps to VQLCollectorArgs.max_row). */
  maxRows?: number
  /** Overall deadline for the streamed query. */
  timeoutMs?: number
  /** Velociraptor org id to scope the query to (VQLCollectorArgs.org_id). */
  orgId?: string
}

/**
 * The swappable transport. The default implementation is gRPC over mTLS
 * (createGrpcTransport); tests and future transports (e.g. a REST bridge) provide
 * their own. `runVQL` executes one VQL string and returns its rows.
 */
export interface VelociraptorTransport {
  runVQL(query: string, opts?: RunVqlOptions): Promise<VqlRow[]>
  close(): Promise<void>
}

/** High-level client built on a transport: VQL + a version/connectivity probe. */
export interface VelociraptorClient {
  runVQL(query: string, opts?: RunVqlOptions): Promise<VqlRow[]>
  /** Runs INFO_VQL and returns a version-ish string, or null if unreachable. */
  getVersion(opts?: RunVqlOptions): Promise<string | null>
  close(): Promise<void>
}

export interface TransportOptions extends RunVqlOptions {
  /**
   * SSL target name override. Velociraptor's API server cert is issued to the
   * server's configured name, not its host, so gRPC hostname verification needs
   * this override. VERIFY: default 'VelociraptorServer' matches the deployment.
   */
  sslTargetNameOverride?: string
  /** Absolute path to the proto file; defaults to the shipped velociraptor.proto. */
  protoPath?: string
}

export const DEFAULT_SSL_TARGET_NAME_OVERRIDE = 'VelociraptorServer'
export const DEFAULT_VQL_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_ROWS = 10_000

/**
 * gRPC/mTLS transport. Lazily loads @grpc/grpc-js + @grpc/proto-loader so that
 * static handlers (validate) never pull the transport, and so the dependency is
 * isolated to exactly the code path that talks to the server.
 *
 * VERIFY (all flagged in velociraptor.proto): service `proto.API`, server-
 * streaming method `Query(VQLCollectorArgs) returns (stream VQLResponse)`, and
 * that each VQLResponse.Response is a JSON array of row objects.
 */
export async function createGrpcTransport(
  config: ApiClientConfig,
  opts: TransportOptions = {},
): Promise<VelociraptorTransport> {
  if (!isApiClientConfigComplete(config)) {
    throw new Error(
      'Incomplete api-client config: need ca_certificate, client_cert, client_private_key and api_connection_string.',
    )
  }

  const grpc = await import('@grpc/grpc-js')
  const protoLoader = await import('@grpc/proto-loader')

  const protoFile = opts.protoPath || path.join(__dirname, 'velociraptor.proto')
  const packageDefinition = protoLoader.loadSync(protoFile, {
    keepCase: true, // preserve VQL/Name/Response/Columns casing from the proto
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    proto: { API: new (address: string, creds: unknown, options?: Record<string, unknown>) => GrpcApiClient }
  }

  const channelCredentials = grpc.credentials.createSsl(
    Buffer.from(config.caCertificate, 'utf8'),
    Buffer.from(config.clientPrivateKey, 'utf8'),
    Buffer.from(config.clientCert, 'utf8'),
  )

  const client = new loaded.proto.API(config.apiConnectionString, channelCredentials, {
    'grpc.ssl_target_name_override': opts.sslTargetNameOverride || DEFAULT_SSL_TARGET_NAME_OVERRIDE,
    'grpc.default_authority': opts.sslTargetNameOverride || DEFAULT_SSL_TARGET_NAME_OVERRIDE,
  })

  const runVQL = (query: string, runOpts: RunVqlOptions = {}): Promise<VqlRow[]> =>
    new Promise((resolve, reject) => {
      const timeoutMs = runOpts.timeoutMs ?? opts.timeoutMs ?? DEFAULT_VQL_TIMEOUT_MS
      const args = {
        Query: [{ Name: 'Veltrix', VQL: query }],
        max_row: String(runOpts.maxRows ?? opts.maxRows ?? DEFAULT_MAX_ROWS),
        ...(runOpts.orgId || opts.orgId ? { org_id: runOpts.orgId ?? opts.orgId } : {}),
      }
      const deadline = new Date(Date.now() + timeoutMs)
      const rows: VqlRow[] = []
      const call = client.Query(args, { deadline })
      call.on('data', (resp: { Response?: string }) => {
        if (resp?.Response) {
          try {
            const parsed = JSON.parse(resp.Response)
            if (Array.isArray(parsed)) rows.push(...(parsed as VqlRow[]))
          } catch {
            // A packet whose Response is not JSON (e.g. a log line) is ignored.
          }
        }
      })
      call.on('error', (err: Error) => reject(err))
      call.on('end', () => resolve(rows))
    })

  return {
    runVQL,
    close: async () => {
      const closable = client as unknown as { close?: () => void }
      closable.close?.()
    },
  }
}

/** Minimal shape of the generated gRPC client this module drives. */
interface GrpcApiClient {
  Query(args: unknown, options?: { deadline?: Date }): GrpcServerStream
  close?(): void
}
interface GrpcServerStream {
  on(event: 'data', cb: (resp: { Response?: string }) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'end', cb: () => void): void
}

/**
 * Build a high-level client over a transport. The default transport factory is
 * the gRPC/mTLS one; pass a custom `transport` (tests, alternate wire) to swap it.
 */
export async function createVelociraptorClient(
  config: ApiClientConfig,
  opts: TransportOptions & { transport?: VelociraptorTransport } = {},
): Promise<VelociraptorClient> {
  const transport = opts.transport ?? (await createGrpcTransport(config, opts))

  return {
    runVQL: (query, runOpts) => transport.runVQL(query, runOpts),
    getVersion: async (runOpts) => {
      const rows = await transport.runVQL(INFO_VQL, runOpts)
      return extractVersion(rows)
    },
    close: () => transport.close(),
  }
}

/**
 * Pull a version-ish value out of an info() row. VERIFY: `info()` returns a
 * `version` field (or a nested `Version.Version`); read defensively.
 */
export function extractVersion(rows: VqlRow[]): string | null {
  const row = rows[0]
  if (!row) return null
  const direct = row['version'] ?? row['Version']
  if (typeof direct === 'string') return direct
  if (direct && typeof direct === 'object') {
    const nested = (direct as Record<string, unknown>)['version'] ?? (direct as Record<string, unknown>)['Version']
    if (typeof nested === 'string') return nested
  }
  return rows.length > 0 ? 'connected' : null
}
