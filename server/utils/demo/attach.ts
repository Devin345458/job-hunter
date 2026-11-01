import { eq } from 'drizzle-orm'
import { applications } from '../../db/schema'
import type { TailoredResume } from '#shared/types/pipeline'
import { saveResumePdf } from '../pdf'
import { getDemo, githubRepoUrl } from './store'

// Puts a built demo on the application's tailored resume (the projects array) and
// regenerates the PDF, and takes it off again when the demo is discarded. The URL is the
// GitHub URL the repo gets on publish; the resume only reaches an employer after approve,
// and approve publishes the demo before it submits anything.

export interface AttachResult {
  updated: boolean
  pdfPath: string | null
  reason: string | null
}

async function rewrite(applicationId: number, edit: (projects: NonNullable<TailoredResume['projects']>) => NonNullable<TailoredResume['projects']>): Promise<AttachResult> {
  const db = useDb()
  const app = db.select().from(applications).where(eq(applications.id, applicationId)).get()
  if (!app) return { updated: false, pdfPath: null, reason: 'application not found' }
  const resume = parseJson<TailoredResume | null>(app.tailoredResumeJson, null)
  if (!resume) return { updated: false, pdfPath: null, reason: 'the application has no tailored resume yet' }
  resume.projects = edit(resume.projects ?? [])
  const pdfPath = app.tailoredResumePdfPath
    ? resolveStoredPath(app.tailoredResumePdfPath)
    : dataPath('resumes', `application-${applicationId}.pdf`)
  const { name, contact } = candidateContact()
  await saveResumePdf(resume, name, contact, pdfPath)
  db.update(applications)
    .set({ tailoredResumeJson: JSON.stringify(resume), tailoredResumePdfPath: pdfPath, updatedAt: nowSql() })
    .where(eq(applications.id, applicationId))
    .run()
  return { updated: true, pdfPath, reason: null }
}

export async function attachDemoToResume(demoId: number): Promise<AttachResult> {
  const demo = getDemo(demoId)
  if (!demo?.repoName) return { updated: false, pdfPath: null, reason: 'demo has no repo name' }
  const url = githubRepoUrl(demo.repoName)
  return rewrite(demo.applicationId, (projects) => [
    ...projects.filter(p => p.url !== url && p.name !== demo.title),
    { name: demo.title, description: demo.summary ?? '', url },
  ])
}

export async function detachDemoFromResume(demoId: number): Promise<AttachResult> {
  const demo = getDemo(demoId)
  if (!demo?.repoName) return { updated: false, pdfPath: null, reason: 'demo has no repo name' }
  const url = githubRepoUrl(demo.repoName)
  return rewrite(demo.applicationId, projects => projects.filter(p => p.url !== url))
}
