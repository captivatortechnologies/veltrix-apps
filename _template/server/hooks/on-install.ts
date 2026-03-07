// Called when the app is first installed.
// Use this for database seeding, initial setup, etc.

interface InstallContext {
  db: any // PrismaClient
  appId: string
}

export default async function onInstall(ctx: InstallContext): Promise<void> {
  console.log(`[${ctx.appId}] App installed successfully`)
  // Example: Seed default data
  // await ctx.db.$executeRaw`INSERT INTO ...`
}
