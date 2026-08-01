import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Project settings (primary branch + tags)']

/**
 * Step-by-step connection guide for Semgrep, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Semgrep AppSec Platform, go to <strong>Settings → Tokens</strong> and create an API token
              (a Team or Enterprise tier account is required). It authenticates every call as{' '}
              <code>Authorization: Bearer &lt;token&gt;</code> and can manage:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the token as a Veltrix credential on the <strong>Connections</strong> page — in the token
              field.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connection',
      label: '2. Connection & slug',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On <strong>Connections</strong>, add a connection and attach the API token. The Semgrep base URL is
              fixed (<code>https://semgrep.dev/api/v1</code>), so leave the endpoint as <code>semgrep.dev</code>.
              Then set the app's <strong>Deployment Slug</strong> setting — your tenant identifier, found at{' '}
              <code>GET /api/v1/deployments</code> or in the Semgrep Settings. Use <strong>Test</strong> to verify
              the token is valid (GET <code>/api/v1/deployments</code>) and that it can reach your deployment.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'author',
      label: '3. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Open the <strong>Configuration Canvas</strong>, pick the Semgrep{' '}
              <strong>Project Settings</strong> configuration type, and author the projects you manage — the
              project name (e.g. <code>my-org/my-repo</code>), an optional primary branch, and the tag set. The
              project must already exist in Semgrep (created by connecting the repository and running a scan).
              Deploy through the pipeline; drift detection and rollback are handled for you.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
