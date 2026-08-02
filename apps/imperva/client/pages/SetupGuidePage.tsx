import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['ACL Rules']

/**
 * Step-by-step connection guide for Imperva Cloud WAF, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the <strong>Imperva Cloud Security Console → Account → API Keys</strong>, create an API
              key. You get two values: an <strong>API ID</strong> and an <strong>API key</strong>. Grant
              it permission to manage site security (IncapRules). This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the values as a Veltrix credential on the <strong>Connections</strong> page: the{' '}
              <strong>API ID</strong> as the username and the <strong>API key</strong> as the API token.
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
              On <strong>Connections</strong>, add a connection and attach the API ID / API key
              credential. The endpoint defaults to the Cloud WAF management API{' '}
              (<code>https://my.imperva.com/api/prov/v1</code>) — leave it blank to use the default, or
              set it to override the management host. Use <strong>Test</strong> to verify the API is
              reachable and the credential authenticates (POST <code>/account</code>). Saving the
              connection also registers Imperva as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the Imperva <strong>ACL Rules</strong>{' '}
              configuration type, and author your rules. Each rule targets a <strong>Site ID</strong> and
              carries a <strong>name</strong>, an <strong>action</strong> (block, alert or challenge), a{' '}
              <strong>filter</strong> (the ACL condition — e.g. <code>ClientIP == "203.0.113.7"</code>,{' '}
              <code>CountryCode == "CN"</code> or <code>Full-URL contains "/admin"</code>) and a{' '}
              <strong>state</strong>. Deploy through the pipeline — rules are upserted by name within the
              site, and drift detection and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
