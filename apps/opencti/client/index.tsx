import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))
const BYOLPage = React.lazy(() => import('./pages/BYOLPage'))

export default {
  id: 'opencti',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage, BYOLPage },
  sidebarItems: [
    { path: '/apps/opencti/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/opencti/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/opencti/connections', label: 'Connections', icon: 'link' },
    { path: '/apps/opencti/byol', label: 'Infrastructure', icon: 'server' },
  ],
}
