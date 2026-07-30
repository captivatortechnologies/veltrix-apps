import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['CDB lists']

/**
 * Step-by-step connection guide for Wazuh, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API user',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Wazuh, create (or reuse) an API user for Veltrix with permission to manage the ruleset. This
              app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the API username + password as a Veltrix credential on the <strong>Connections</strong>
              page. The connection endpoint is your <strong>manager's API host</strong> (the Wazuh REST API on
              55000).
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
              On <strong>Connections</strong>, add a connection pointing at the manager API host (port 55000)
              and attach the credential. Use <strong>Test</strong> to verify the Wazuh API is reachable and the
              credential authenticates (it exchanges the username/password for a bearer token). Saving the
              connection also registers the manager as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick a Wazuh configuration type (CDB Lists),
              author your items, and deploy through the pipeline. Drift detection and rollback are handled per
              type over the Wazuh REST API.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
