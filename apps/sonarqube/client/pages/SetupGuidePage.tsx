import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Quality gates']

/**
 * Step-by-step connection guide for SonarQube, rendered with the platform
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
              In SonarQube, go to <strong>My Account → Security</strong> and generate a token (a project- or
              global-analysis token with <strong>Administer Quality Gates</strong> permission). This app
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
              Store the token as a Veltrix credential on the <strong>Connections</strong> page (API token
              field). SonarQube authenticates with the token alone — it is sent as HTTP Basic with the token as
              the username and no password; newer servers also accept it as a bearer token.
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
              On <strong>Connections</strong>, add a connection pointing at your SonarQube URL (e.g.{' '}
              <code>https://sonarqube.example.com</code> or <code>http://host:9000</code>) and attach the API
              token. Use <strong>Test</strong> to verify SonarQube is reachable and the token authenticates
              (GET <code>/api/system/status</code> + <code>/api/authentication/validate</code>). Saving the
              connection also registers the SonarQube server as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the SonarQube <strong>Quality Gates</strong>
              configuration type, author your gates (name, default flag, and conditions such as{' '}
              <code>new_coverage LT 80</code>), and deploy through the pipeline. Drift detection and rollback
              are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
