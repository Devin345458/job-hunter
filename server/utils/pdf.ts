import { createRequire } from 'module'
import { writeFileSync, existsSync, mkdirSync } from 'fs'
// Static import so the production build's file trace copies pdfmake and its dependencies into
// .output/server/node_modules. A dynamic require() is invisible to the trace, which left the
// deployed image without pdfmake ("Cannot find module 'pdfmake/js/Printer'").
import PdfPrinterModule from 'pdfmake/js/Printer.js'
import { dirname } from 'path'
import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces'
import type { TailoredResume } from '#shared/types/pipeline'

export interface ContactInfo {
  email?: string
  phone?: string
  location?: string
  linkedin?: string
  github?: string
}

function getPrinter() {
  const PdfPrinter = (PdfPrinterModule as any).default || PdfPrinterModule
  // Made here, when a PDF is made, never at module load. The production build turns
  // import.meta.url into a global that .output/server/index.mjs sets in its body, after every
  // import has run. When this file lands in a chunk that loads at startup (the job queue's worker
  // plugin imports it), a require made at module load would resolve from "/_entry.js" and miss
  // .output/server/node_modules ("Cannot find module 'pdfmake/fonts/Roboto/Roboto-Regular.ttf'").
  const require = createRequire(import.meta.url)
  const fonts = {
    Roboto: {
      normal: require.resolve('pdfmake/fonts/Roboto/Roboto-Regular.ttf'),
      bold: require.resolve('pdfmake/fonts/Roboto/Roboto-Medium.ttf'),
      italics: require.resolve('pdfmake/fonts/Roboto/Roboto-Italic.ttf'),
      bolditalics: require.resolve('pdfmake/fonts/Roboto/Roboto-MediumItalic.ttf'),
    },
  }
  return new PdfPrinter(fonts)
}

/** GitHub and LinkedIn are stored as handles or URLs; print them as short links either way. */
function linkText(value: string | undefined, host: string): string | undefined {
  if (!value) return undefined
  if (/^https?:\/\//i.test(value)) return value.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')
  return value.includes('.') ? value : `${host}/${value.replace(/^@/, '')}`
}

function contactLineOf(contactInfo: ContactInfo): string {
  return [
    contactInfo.email,
    contactInfo.phone,
    contactInfo.location,
    linkText(contactInfo.linkedin, 'linkedin.com/in'),
    linkText(contactInfo.github, 'github.com'),
  ].filter(Boolean).join('  |  ')
}

const STYLES: TDocumentDefinitions['styles'] = {
  name: { fontSize: 18, bold: true, color: '#1a1a1a' },
  contactInfo: { fontSize: 9, color: '#555555' },
  sectionHeader: { fontSize: 11, bold: true, color: '#1a1a1a', margin: [0, 8, 0, 4] },
  jobTitle: { fontSize: 10, bold: true, color: '#333333' },
  jobPeriod: { fontSize: 9, color: '#666666', italics: true },
  body: { fontSize: 10, color: '#333333' },
}

async function render(docDefinition: TDocumentDefinitions): Promise<Buffer> {
  const printer = getPrinter()
  const pdfDoc = await printer.createPdfKitDocument(docDefinition)
  const chunks: Buffer[] = []
  return new Promise<Buffer>((resolve, reject) => {
    pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk))
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)))
    pdfDoc.on('error', reject)
    pdfDoc.end()
  })
}

function header(candidateName: string, contactInfo: ContactInfo, width = 532, gap = 1): Content[] {
  return [
    { text: candidateName, style: 'name', alignment: 'center' },
    { text: contactLineOf(contactInfo), style: 'contactInfo', alignment: 'center', margin: [0, 2, 0, 10 * gap] },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 1, lineColor: '#333333' }], margin: [0, 0, 0, 10 * gap] },
  ]
}

const LETTER_WIDTH = 612

/**
 * How tightly a resume is set. The first entry is the normal layout. A resume that runs onto a
 * second page is tried again with tighter spacing, and only the last entry makes the text
 * smaller. Nothing is ever left out. When even the last entry needs two pages, the resume is not
 * a near fit and keeps the normal layout on two pages.
 */
interface Density {
  /** Page margins: left, top, right, bottom. */
  margins: [number, number, number, number]
  fontSize: number
  lineHeight: number
  /** Multiplies the space between blocks. */
  gap: number
}

const DENSITIES: Density[] = [
  { margins: [40, 40, 40, 40], fontSize: 10, lineHeight: 1.3, gap: 1 },
  { margins: [38, 32, 38, 32], fontSize: 10, lineHeight: 1.24, gap: 0.8 },
  { margins: [36, 28, 36, 28], fontSize: 10, lineHeight: 1.18, gap: 0.6 },
  { margins: [36, 28, 36, 28], fontSize: 9.5, lineHeight: 1.16, gap: 0.55 },
]

type Margin = [number, number, number, number]

/** The resume as a pdfmake document at one density. Each section heading is kept on the page with its first entry. */
function resumeDocument(input: TailoredResume, candidateName: string, contactInfo: ContactInfo, d: Density): TDocumentDefinitions {
  // pdfmake rewrites list items in place (strings become layout objects), so every render gets a copy.
  const resume: TailoredResume = structuredClone(input)
  const g = (n: number) => Math.round(n * d.gap * 10) / 10
  const width = LETTER_WIDTH - d.margins[0] - d.margins[2]
  const scale = d.fontSize / 10
  // The normal layout's spacing is the original one: 8 above a heading and 4 below it.
  const heading = (text: string): Content => ({ text, style: 'sectionHeader', margin: [0, g(8), 0, g(4)] as Margin })
  /**
   * A heading and its first entry in one unbreakable stack, so a heading never ends a page on its
   * own, followed by the rest of the section's entries, each of which also stays whole.
   */
  const section = (title: string, entries: Content[]): Content[] => entries.length
    ? [{ stack: [heading(title), entries[0]!], unbreakable: true } as Content, ...entries.slice(1)]
    : []

  const experience: Content[] = resume.experience.map(exp => ({
    stack: [
      {
        columns: [
          { text: `${exp.title}, ${exp.company}`, style: 'jobTitle', width: '*' },
          { text: exp.period, style: 'jobPeriod', width: 'auto', alignment: 'right' as const },
        ],
        margin: [0, g(6), 0, g(2)] as Margin,
      },
      { ul: exp.bullets, style: 'body', margin: [10, g(2), 0, g(6)] as Margin },
    ],
    unbreakable: true,
  } as Content))

  // Projects: demo projects and knowledge base projects.
  const projects: Content[] = (resume.projects ?? []).map(p => ({
    stack: [
      {
        text: [
          { text: p.name, bold: true },
          ...(p.url ? [{ text: `   ${p.url}`, link: p.url, color: '#2a5db0', fontSize: 9 * scale }] : []),
        ],
        style: 'body',
        margin: [0, g(4), 0, 1] as Margin,
      },
      { text: p.description, style: 'body', margin: [0, 0, 0, g(4)] as Margin },
    ],
    unbreakable: true,
  } as Content))

  const skills: Content[] = Object.entries(resume.skills).map(([category, list]) => ({
    text: [
      { text: `${category}: `, bold: true },
      { text: list.join(', ') },
    ],
    style: 'body' as const,
    margin: [0, g(2), 0, g(2)] as Margin,
  }))

  // Education is short, so it stays together as one block with its heading.
  const education: Content[] = resume.education.length
    ? [{
        stack: resume.education.map(edu => ({
          columns: [
            { text: [edu.degree, edu.institution].filter(Boolean).join(', '), style: 'body' as const, width: '*' as const },
            { text: edu.year || '', style: 'body' as const, width: 'auto' as const, alignment: 'right' as const },
          ],
          margin: [0, g(2), 0, g(2)] as Margin,
        })),
      } as Content]
    : []

  return {
    pageSize: 'LETTER',
    pageMargins: d.margins,
    defaultStyle: { font: 'Roboto', fontSize: d.fontSize, lineHeight: d.lineHeight },
    styles: {
      name: { fontSize: 18 * scale, bold: true, color: '#1a1a1a' },
      contactInfo: { fontSize: 9 * scale, color: '#555555' },
      sectionHeader: { fontSize: 11 * scale, bold: true, color: '#1a1a1a' },
      jobTitle: { fontSize: 10 * scale, bold: true, color: '#333333' },
      jobPeriod: { fontSize: 9 * scale, color: '#666666', italics: true },
      body: { fontSize: 10 * scale, color: '#333333' },
    },
    content: [
      ...header(candidateName, contactInfo, width, d.gap),
      { stack: [heading('PROFESSIONAL SUMMARY'), { text: resume.summary, style: 'body', margin: [0, g(4), 0, g(12)] as Margin }], unbreakable: true },
      ...section('EXPERIENCE', experience),
      ...section('PROJECTS', projects),
      ...section('TECHNICAL SKILLS', skills),
      ...section('EDUCATION', education),
    ],
  } as TDocumentDefinitions
}

/** Renders a document and reports how many pages it took. */
async function renderCounted(doc: TDocumentDefinitions): Promise<{ pdf: Buffer; pages: number }> {
  let pages = 0
  const pdf = await render({ ...doc, footer: (_page: number, pageCount: number) => { pages = pageCount; return null } } as TDocumentDefinitions)
  return { pdf, pages }
}

export async function generateResumePdf(
  input: TailoredResume,
  candidateName: string,
  contactInfo: ContactInfo,
): Promise<Buffer> {
  const first = await renderCounted(resumeDocument(input, candidateName, contactInfo, DENSITIES[0]!))
  if (first.pages <= 1) return first.pdf
  // Runs onto a second page: try the tighter settings in order and take the first that fits one page.
  for (const d of DENSITIES.slice(1)) {
    const tight = await renderCounted(resumeDocument(input, candidateName, contactInfo, d))
    if (tight.pages <= 1) return tight.pdf
  }
  return first.pdf
}

/** The cover letter as a one-page PDF, for forms that ask for a cover letter file. */
export async function generateCoverLetterPdf(letter: string, candidateName: string, contactInfo: ContactInfo): Promise<Buffer> {
  const paragraphs = letter.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  return render({
    pageSize: 'LETTER',
    pageMargins: [56, 48, 56, 48],
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.4 },
    styles: STYLES,
    content: [
      ...header(candidateName, contactInfo),
      { text: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), style: 'body', margin: [0, 0, 0, 12] },
      ...paragraphs.map(p => ({ text: p, style: 'body' as const, margin: [0, 0, 0, 10] as [number, number, number, number] })),
    ],
  })
}

function writeBuffer(outputPath: string, buffer: Buffer) {
  const dir = dirname(outputPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(outputPath, buffer)
  return outputPath
}

export async function saveResumePdf(
  resume: TailoredResume,
  candidateName: string,
  contactInfo: ContactInfo,
  outputPath: string,
): Promise<string> {
  return writeBuffer(outputPath, await generateResumePdf(resume, candidateName, contactInfo))
}

export async function saveCoverLetterPdf(letter: string, candidateName: string, contactInfo: ContactInfo, outputPath: string): Promise<string> {
  return writeBuffer(outputPath, await generateCoverLetterPdf(letter, candidateName, contactInfo))
}
