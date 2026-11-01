// Owned by capability B (demo projects). Pushes a built demo to GitHub and adds it to the
// resume site. Only the approval orchestrator calls it, and only after Devin's approve click.
export async function publishDemo(demoId: number): Promise<{ repoUrl: string; liveUrl: string | null }> {
  throw new Error(`Demo publishing is not built yet (demo ${demoId})`)
}
