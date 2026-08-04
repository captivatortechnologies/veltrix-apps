import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage, type GraphQLError, type WizClient } from '../../lib/wiz'
import { extractIntegrationSpecs, integrationKey, tryParseJson, type IntegrationSpec, type LiveIntegration } from './validate'

// --- GraphQL operations --------------------------------------------------------
//
// Wiz's schema is ONE generic createIntegration / updateIntegration /
// deleteIntegration mutation set (VERIFIED against the generated Wiz GraphQL
// SDK type surface — terraform-provider-wiz's internal/wiz Go package,
// CreateIntegrationInput / CreateIntegrationParamsInput / UpdateIntegrationInput
// / UpdateIntegrationPatch). The `integrations` list query itself is inferred
// from the now-repeated plural-list / singular-by-id naming convention this app
// already relies on elsewhere in this schema — see canvas.yaml.
//
// `params` is deliberately NEVER read back (it is a GraphQL union Wiz cannot
// generically select, and — more importantly — this app treats every
// credential a vendor integration carries as write-only by design; see
// canvas.yaml). Consequently there is no single-object "GetIntegration" read
// query here: existence/identity comes from the list, and "prior state" for
// rollback comes from ctx.previousConfig (the canvas this app itself declared
// last time), never from Wiz.

/** List integrations (Relay connection). */
export const LIST_INTEGRATIONS_QUERY = `
query ListIntegrations($first: Int, $after: String) {
  integrations(first: $first, after: $after) {
    nodes {
      id
      name
      type
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

const CREATE_INTEGRATION_MUTATION = `
mutation CreateIntegration($input: CreateIntegrationInput!) {
  createIntegration(input: $input) {
    integration { id }
  }
}`

const UPDATE_INTEGRATION_MUTATION = `
mutation UpdateIntegration($input: UpdateIntegrationInput!) {
  updateIntegration(input: $input) {
    integration { id }
  }
}`

const PAGE_SIZE = 100

export interface IntegrationRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  /** The FULL prior canvas-declared spec (from ctx.previousConfig) — never a live API read. */
  prior?: IntegrationSpec
}

interface MutateIntegrationResult {
  createIntegration?: { integration?: { id?: string } }
  updateIntegration?: { integration?: { id?: string } }
}

/**
 * Deploy Wiz integrations via the GraphQL API.
 *
 * Identity is the integration `name`: list the tenant's integrations, match on
 * the name, then update it or create a new one. Because every vendor
 * credential here is write-only by design (never read back from Wiz), rollback
 * state for an UPDATED integration is captured from ctx.previousConfig — what
 * this app itself declared on the previous deploy — not from a live read.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractIntegrationSpecs(ctx.canvas).filter((s) => s.name && s.integrationType)
  const previousSpecs = ctx.previousConfig ? extractIntegrationSpecs(ctx.previousConfig) : []
  const previousByName = new Map(previousSpecs.filter((s) => s.name).map((s) => [integrationKey(s.name), s]))

  const rollbackState: IntegrationRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listIntegrations(client)
    const byName = new Map(existing.filter((i) => i.name).map((i) => [integrationKey(i.name as string), i]))

    for (const spec of specs) {
      const label = spec.name
      const key = integrationKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: previousByName.get(key) })
        const res = await client.graphql<MutateIntegrationResult>(UPDATE_INTEGRATION_MUTATION, {
          input: { id: live.id, patch: buildIntegrationPatch(spec) },
        })
        assertMutationOk(res.transportError, res.errors, `update integration "${label}"`)
      } else {
        const res = await client.graphql<MutateIntegrationResult>(CREATE_INTEGRATION_MUTATION, {
          input: buildIntegrationInput(spec),
        })
        assertMutationOk(res.transportError, res.errors, `create integration "${label}"`)
        const id = res.data?.createIntegration?.integration?.id
        if (!id) throw new Error(`Integration "${label}" was created but Wiz returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Wiz integration(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedIntegrations: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Integration deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedIntegrations: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List all integrations; throws on error. */
export async function listIntegrations(client: WizClient): Promise<LiveIntegration[]> {
  const res = await client.listConnection<LiveIntegration>(LIST_INTEGRATIONS_QUERY, 'integrations', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Wiz integrations: ${res.error}`)
  return res.nodes
}

/** The `CreateIntegrationInput` for a spec. */
export function buildIntegrationInput(spec: IntegrationSpec): Record<string, unknown> {
  const input: Record<string, unknown> = {
    name: spec.name,
    type: spec.integrationType,
    params: buildIntegrationParams(spec),
    isAccessibleToAllProjects: spec.isAccessibleToAllProjects,
  }
  if (spec.projectId) input.projectId = spec.projectId
  return input
}

/** The `UpdateIntegrationPatch` for a spec (same params shape as create). */
export function buildIntegrationPatch(spec: IntegrationSpec): Record<string, unknown> {
  return {
    name: spec.name,
    params: buildIntegrationParams(spec),
  }
}

/** Build the `params` union object, keyed by the declared integration type. */
export function buildIntegrationParams(spec: IntegrationSpec): Record<string, unknown> {
  switch (spec.integrationType) {
    case 'WEBHOOK':
      return { webhook: buildWebhookParams(spec) }
    case 'SLACK':
      return { slack: { url: spec.slackWebhookUrl } }
    case 'SLACK_BOT':
      return { slackBot: { token: spec.slackBotToken } }
    case 'AWS_SNS':
      return { awsSNS: buildAwsSnsParams(spec) }
    case 'AZURE_SERVICE_BUS':
      return { azureServiceBus: buildAzureServiceBusParams(spec) }
    case 'GCP_PUB_SUB':
      return { gcpPubSub: buildGcpPubSubParams(spec) }
    case 'PAGER_DUTY':
      return { pagerDuty: { integrationKey: spec.pagerDutyIntegrationKey } }
    case 'JIRA':
      return { jira: buildJiraParams(spec) }
    case 'SERVICE_NOW':
      return { serviceNow: buildServiceNowParams(spec) }
    case 'OPSGENIE':
      return { opsgenie: { key: spec.opsgenieKey } }
    case 'CLICK_UP':
      return { clickUp: { key: spec.clickUpKey } }
    default:
      return {}
  }
}

function buildWebhookParams(spec: IntegrationSpec): Record<string, unknown> {
  const params: Record<string, unknown> = { url: spec.webhookUrl, isOnPrem: spec.webhookIsOnPrem }
  if (spec.webhookAuthUsername || spec.webhookAuthPassword || spec.webhookAuthToken) {
    params.authorization = {
      username: spec.webhookAuthUsername,
      password: spec.webhookAuthPassword,
      token: spec.webhookAuthToken,
    }
  }
  const headers = tryParseJson(spec.webhookHeadersJson)
  if (headers.ok && Array.isArray(headers.value)) params.headers = headers.value
  if (spec.webhookTlsAllowInsecure || spec.webhookTlsServerCa) {
    params.tlsConfig = { allowInsecureTLS: spec.webhookTlsAllowInsecure, serverCA: spec.webhookTlsServerCa }
  }
  return params
}

function buildAwsSnsParams(spec: IntegrationSpec): Record<string, unknown> {
  const accessMethod: Record<string, unknown> = { type: spec.awsSnsAccessMethodType }
  if (spec.awsSnsAccessMethodType === 'ASSUME_CONNECTOR_ROLE') accessMethod.accessConnectorId = spec.awsSnsAccessConnectorId
  else accessMethod.customerRoleARN = spec.awsSnsCustomerRoleArn
  return { topicARN: spec.awsSnsTopicArn, accessMethod }
}

function buildAzureServiceBusParams(spec: IntegrationSpec): Record<string, unknown> {
  const accessMethod: Record<string, unknown> = { type: spec.azureAccessMethodType }
  if (spec.azureAccessMethodType === 'CONNECTOR_CREDENTIALS') accessMethod.accessConnectorId = spec.azureAccessConnectorId
  else accessMethod.connectionStringWithSas = spec.azureConnectionStringWithSas
  return { queueUrl: spec.azureQueueUrl, accessMethod }
}

function buildGcpPubSubParams(spec: IntegrationSpec): Record<string, unknown> {
  const accessMethod: Record<string, unknown> = { type: spec.gcpAccessMethodType }
  if (spec.gcpAccessMethodType === 'CONNECTOR_CREDENTIALS') {
    accessMethod.accessConnectorId = spec.gcpAccessConnectorId
  } else {
    const parsed = tryParseJson(spec.gcpServiceAccountKey)
    accessMethod.serviceAccountKey = parsed.ok && parsed.value !== undefined ? parsed.value : spec.gcpServiceAccountKey
  }
  return { projectId: spec.gcpProjectId, topicId: spec.gcpTopicId, accessMethod }
}

function buildJiraParams(spec: IntegrationSpec): Record<string, unknown> {
  const params: Record<string, unknown> = {
    serverUrl: spec.jiraServerUrl,
    serverType: spec.jiraServerType,
    isOnPrem: spec.jiraIsOnPrem,
  }
  if (spec.jiraTlsAllowInsecure || spec.jiraTlsServerCa || spec.jiraTlsClientCertAndKey) {
    params.tlsConfig = {
      allowInsecureTLS: spec.jiraTlsAllowInsecure,
      serverCA: spec.jiraTlsServerCa,
      clientCertificateAndPrivateKey: spec.jiraTlsClientCertAndKey,
    }
  }
  const authorization: Record<string, unknown> = {}
  if (spec.jiraAuthUsername) authorization.username = spec.jiraAuthUsername
  if (spec.jiraAuthPassword) authorization.password = spec.jiraAuthPassword
  if (spec.jiraAuthPat) authorization.personalAccessToken = spec.jiraAuthPat
  params.authorization = authorization
  return params
}

function buildServiceNowParams(spec: IntegrationSpec): Record<string, unknown> {
  const authorization: Record<string, unknown> = {
    username: spec.serviceNowAuthUsername,
    password: spec.serviceNowAuthPassword,
  }
  if (spec.serviceNowAuthClientId) authorization.clientId = spec.serviceNowAuthClientId
  if (spec.serviceNowAuthClientSecret) authorization.clientSecret = spec.serviceNowAuthClientSecret
  return { url: spec.serviceNowUrl, authorization }
}

/** Throw a descriptive error when a mutation failed at the transport or GraphQL level. */
function assertMutationOk(transportError: string | null, errors: GraphQLError[] | null, action: string): void {
  if (transportError) throw new Error(`Failed to ${action}: ${transportError}`)
  if (errors) throw new Error(`Failed to ${action}: ${graphqlErrorMessage(errors)}`)
}
