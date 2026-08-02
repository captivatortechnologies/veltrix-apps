import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Pipelines']

/**
 * Step-by-step connection guide for Cribl, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Cribl authenticates one of two ways. For a self-managed{' '}
              <strong>on-prem Leader</strong>, use a Cribl <strong>username and password</strong> — the app
              exchanges them at <code>POST /api/v1/auth/login</code> for a short-lived Bearer token. For{' '}
              <strong>Cribl.Cloud</strong>, obtain a <strong>Bearer token</strong> from your API credentials
              (OAuth client-credentials at <code>login.cribl.cloud/oauth/token</code>) and store it as the
              credential token. This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connection',
      label: '2. Connection',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On <strong>Connections</strong>, add a connection pointing at your Cribl endpoint (the Leader's
              host — on-prem defaults to port <code>9000</code>; Cribl.Cloud is on <code>443</code>) and attach
              the credential. Use <strong>Test</strong> to verify Cribl is reachable and the credential
              authenticates (obtain a Bearer, then <code>GET /api/v1/system/info</code>). Saving the connection
              also registers the Cribl Leader as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the Cribl <strong>Pipelines</strong>
              configuration type, author your pipelines (an id, a target Worker Group, and the Function chain as
              conf JSON), and deploy through the pipeline. Drift detection and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
