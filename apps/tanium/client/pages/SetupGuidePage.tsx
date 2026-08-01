import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Computer groups']

/**
 * Step-by-step connection guide for Tanium, rendered with the platform
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
              Authenticate to the Tanium REST v2 API one of two ways. Preferred: create an{' '}
              <strong>API token</strong> in Tanium under{' '}
              <strong>Administration → Permissions → API Tokens</strong> (shown once at creation). Alternative:
              a Tanium <strong>username and password</strong>, which the app exchanges for a session at deploy
              time. This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the API token (or username + password) as a Veltrix credential on the{' '}
              <strong>Connections</strong> page.
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
              On <strong>Connections</strong>, add a connection pointing at your Tanium Server / Tanium Cloud
              host (its HTTPS address on 443) and attach the credential. Use <strong>Test</strong> to verify
              Tanium is reachable and the credential authenticates (GET <code>/api/v2/system_status</code>).
              Saving the connection also registers the Tanium server as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the Tanium <strong>Computer Groups</strong>
              configuration type, author your groups (name + a filter expression such as{' '}
              <code>Operating System contains Windows</code>), and deploy through the pipeline. Drift detection
              and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
