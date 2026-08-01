import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Marking definitions']

/**
 * Step-by-step connection guide for OpenCTI, rendered with the platform
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
              In OpenCTI, open your <strong>Profile → API access</strong> and copy your personal API token
              (or create a dedicated service user with the right permissions and use its token). This app
              manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the API token as a Veltrix credential on the <strong>Connections</strong> page. OpenCTI
              authenticates with the token alone (sent as a Bearer token) — no username is required.
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
              On <strong>Connections</strong>, add a connection pointing at your OpenCTI host (its HTTPS
              address) and attach the API token. Use <strong>Test</strong> to verify OpenCTI is reachable and
              the token authenticates (a GraphQL <code>about {'{'} version {'}'}</code> query). Saving the
              connection also registers the OpenCTI platform as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the OpenCTI{' '}
              <strong>Marking Definitions</strong> configuration type, author your markings (type, definition,
              color, order), and deploy through the pipeline. Drift detection and rollback are handled per
              type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
