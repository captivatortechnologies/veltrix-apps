import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Saved queries']

/**
 * Step-by-step connection guide for Fleet, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. Fleet API token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Fleet, create an API-only user (or reuse an admin) and generate its <strong>API token</strong>
              for Veltrix. This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the token as a Veltrix credential on the <strong>Connections</strong> page. The connection
              endpoint is your <strong>Fleet server's HTTPS host</strong> (fleetdm default 8080; hosted
              commonly 443).
            </p>
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
              On <strong>Connections</strong>, add a connection pointing at the Fleet server host and attach
              the API token. Use <strong>Test</strong> to verify the server is reachable and the token
              authenticates (GET <code>/api/v1/fleet/me</code>). Saving the connection also registers the
              Fleet server as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick a Fleet configuration type (Saved Queries),
              author your items, and deploy through the pipeline. Drift detection and rollback are handled per
              type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
