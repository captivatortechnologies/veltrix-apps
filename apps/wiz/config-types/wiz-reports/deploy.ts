import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage, type GraphQLError, type WizClient } from '../../lib/wiz'
import {
  extractReportSpecs,
  reportKey,
  REPORT_TYPE_GRAPH_QUERY,
  tryParseJson,
  type FullReport,
  type LiveReport,
  type ReportSpec,
} from './validate'

// --- GraphQL operations (verified against the Wiz schema) --------------------

/** List reports (Relay connection). */
export const LIST_REPORTS_QUERY = `
query ListReports($first: Int, $after: String) {
  reports(first: $first, after: $after) {
    nodes {
      id
      name
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

/** Read a single report's full managed state (for update + restore). */
export const GET_REPORT_QUERY = `
query GetReport($id: ID!) {
  report(id: $id) {
    id
    name
    params {
      ... on ReportParamsGraphQuery {
        query
      }
    }
    runIntervalHours
    runStartsAt
  }
}`

const CREATE_REPORT_MUTATION = `
mutation CreateReport($input: CreateReportInput!) {
  createReport(input: $input) {
    report { id }
  }
}`

const UPDATE_REPORT_MUTATION = `
mutation UpdateReport($input: UpdateReportInput!) {
  updateReport(input: $input) {
    report { id }
  }
}`

const PAGE_SIZE = 100

export interface ReportRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: FullReport
}

interface CreateReportResult {
  createReport?: { report?: { id?: string } }
}

interface GetReportResult {
  report?: FullReport
}

/**
 * Deploy Wiz graph-query reports via the GraphQL API.
 *
 * Identity is the report `name`: list the tenant's reports, match on the name,
 * then update it (capturing its prior state for rollback) or create a new one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractReportSpecs(ctx.canvas).filter((s) => s.name && s.query)
  const rollbackState: ReportRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listReports(client)
    const byName = new Map(existing.filter((r) => r.name).map((r) => [reportKey(r.name as string), r]))

    for (const spec of specs) {
      const label = spec.name
      const key = reportKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        const prior = await readReport(client, live.id)
        rollbackState.push({ key, label, existed: true, id: live.id, prior })
        const res = await client.graphql<GetReportResult>(UPDATE_REPORT_MUTATION, {
          input: { id: live.id, override: buildOverride(spec) },
        })
        assertMutationOk(res.transportError, res.errors, `update report "${label}"`)
      } else {
        const res = await client.graphql<CreateReportResult>(CREATE_REPORT_MUTATION, {
          input: buildReportInput(spec),
        })
        assertMutationOk(res.transportError, res.errors, `create report "${label}"`)
        const id = res.data?.createReport?.report?.id
        if (!id) throw new Error(`Report "${label}" was created but Wiz returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Wiz report(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedReports: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Report deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedReports: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List all reports; throws on error. */
export async function listReports(client: WizClient): Promise<LiveReport[]> {
  const res = await client.listConnection<LiveReport>(LIST_REPORTS_QUERY, 'reports', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Wiz reports: ${res.error}`)
  return res.nodes
}

/** Read one report's full managed state; throws on error. */
export async function readReport(client: WizClient, id: string): Promise<FullReport> {
  const res = await client.graphql<GetReportResult>(GET_REPORT_QUERY, { id })
  if (res.transportError) throw new Error(`Failed to read report ${id}: ${res.transportError}`)
  if (res.errors) throw new Error(`Failed to read report ${id}: ${graphqlErrorMessage(res.errors)}`)
  const report = res.data?.report
  if (!report) throw new Error(`Report ${id} was not found`)
  return report
}

/** Parse the spec's graph query JSON into a value for graphQueryParams.query. */
function queryValue(spec: ReportSpec): unknown {
  const parsed = tryParseJson(spec.query)
  return parsed.ok ? parsed.value : undefined
}

/** The `CreateReportInput` for a spec. */
export function buildReportInput(spec: ReportSpec): Record<string, unknown> {
  const input: Record<string, unknown> = {
    name: spec.name,
    type: REPORT_TYPE_GRAPH_QUERY,
    graphQueryParams: { query: queryValue(spec) },
  }
  if (spec.projectId) input.projectId = spec.projectId
  if (spec.runIntervalHours !== null) {
    input.runIntervalHours = spec.runIntervalHours
    if (spec.runStartsAt) input.runStartsAt = spec.runStartsAt
  }
  return input
}

/** The `UpdateReportChange` (override) for a spec. */
export function buildOverride(spec: ReportSpec): Record<string, unknown> {
  const override: Record<string, unknown> = {
    name: spec.name,
    graphQueryParams: { query: queryValue(spec) },
  }
  if (spec.runIntervalHours !== null) {
    override.runIntervalHours = spec.runIntervalHours
    if (spec.runStartsAt) override.runStartsAt = spec.runStartsAt
  }
  return override
}

/** Throw a descriptive error when a mutation failed at the transport or GraphQL level. */
function assertMutationOk(transportError: string | null, errors: GraphQLError[] | null, action: string): void {
  if (transportError) throw new Error(`Failed to ${action}: ${transportError}`)
  if (errors) throw new Error(`Failed to ${action}: ${graphqlErrorMessage(errors)}`)
}
