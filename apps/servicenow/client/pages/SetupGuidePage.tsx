import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Business rules (sys_script)']

/**
 * Step-by-step connection guide for ServiceNow, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. Integration user',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In ServiceNow, create a dedicated <strong>integration user</strong> (User Administration →
              Users) with <strong>Web service access only</strong> and a role scoped to what this app
              manages. Writing business rules requires <code>admin</code> (or an equivalent role that can
              write <code>sys_script</code>). This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the integration user name in the credential <strong>username</strong> field and its
              password in the <strong>password</strong> field on the <strong>Connections</strong> page.
              ServiceNow authenticates with HTTP Basic (OAuth 2.0 is a planned follow-up).
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
              On <strong>Connections</strong>, add a connection pointing at your instance address (e.g.
              <code>dev12345.service-now.com</code>) and attach the username/password credential. Use
              <strong>Test</strong> to verify the instance is reachable and the credential authenticates
              (GET <code>/api/now/table/sys_user?sysparm_limit=1</code>). Saving the connection also
              registers the instance as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the ServiceNow <strong>Business Rules</strong>
              configuration type, author your rules (name, table, when, triggers, condition and script), and
              deploy through the pipeline. Rules are upserted by their (name, table) identity; drift detection
              and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
