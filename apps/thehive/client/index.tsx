import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))
const BYOLPage = React.lazy(() => import('./pages/BYOLPage'))

export default {
  id: 'thehive',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage, BYOLPage },
  sidebarItems: [
    { path: '/apps/thehive/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/thehive/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/thehive/connections', label: 'Connections', icon: 'link' },
    { path: '/apps/thehive/byol', label: 'Infrastructure', icon: 'server' },
  ],
}
