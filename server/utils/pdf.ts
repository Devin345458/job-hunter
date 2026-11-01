import { createRequire } from 'module'
import { writeFileSync, existsSync, mkdirSync } from 'fs'
// Static import so the production build's file trace copies pdfmake and its dependencies into
// .output/server/node_modules. A dynamic require() is invisible to the trace, which left the
// deployed image without pdfmake ("Cannot find module 'pdfmake/js/Printer'").
import PdfPrinterModule from 'pdfmake/js/Printer.js'
import { dirname } from 'path'
import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces'
import type { TailoredResume } from '#shared/types/pipeline'

const require = createRequire(import.meta.url)

export interface ContactInfo {
  email?: string
  phone?: string
  location?: string
  linkedin?: string
  github?: string
}

function getPrinter() {
  const PdfPrinter = (PdfPrinterModule as any).default || PdfPrinterModule
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

function header(candidateName: string, contactInfo: ContactInfo): Content[] {
  return [
    { text: candidateName, style: 'name', alignment: 'center' },
    { text: contactLineOf(contactInfo), style: 'contactInfo', alignment: 'center', margin: [0, 2, 0, 10] },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 532, y2: 0, lineWidth: 1, lineColor: '#333333' }], margin: [0, 0, 0, 10] },
  ]
}

export async function generateResumePdf(
  input: TailoredResume,
  candidateName: string,
  contactInfo: ContactInfo,
): Promise<Buffer> {
  // pdfmake rewrites list items in place (strings become layout objects), so it gets a copy.
  const resume: TailoredResume = structuredClone(input)
  const content: Content = [
    ...header(candidateName, contactInfo),
    { text: 'PROFESSIONAL SUMMARY', style: 'sectionHeader' },
    { text: resume.summary, style: 'body', margin: [0, 4, 0, 12] },
    { text: 'EXPERIENCE', style: 'sectionHeader' },
    ...resume.experience.flatMap(exp => [
      {
        columns: [
          { text: `${exp.title}, ${exp.company}`, style: 'jobTitle', width: '*' },
          { text: exp.period, style: 'jobPeriod', width: 'auto', alignment: 'right' as const },
        ],
        margin: [0, 6, 0, 2] as [number, number, number, number],
      },
      {
        ul: exp.bullets,
        style: 'body',
        margin: [10, 2, 0, 6] as [number, number, number, number],
      },
    ]),
    ...(resume.projects?.length
      ? [
          { text: 'PROJECTS', style: 'sectionHeader', margin: [0, 8, 0, 4] } as Content,
          ...resume.projects.map(p => ({
            text: [
              { text: `${p.name}: `, bold: true },
              { text: p.description },
              ...(p.url ? [{ text: `  ${p.url}`, color: '#555555' }] : []),
            ],
            style: 'body' as const,
            margin: [0, 2, 0, 2] as [number, number, number, number],
          })),
        ]
      : []),
    { text: 'TECHNICAL SKILLS', style: 'sectionHeader', margin: [0, 8, 0, 4] },
    ...Object.entries(resume.skills).map(([category, skills]) => ({
      text: [
        { text: `${category}: `, bold: true },
        { text: skills.join(', ') },
      ],
      style: 'body' as const,
      margin: [0, 2, 0, 2] as [number, number, number, number],
    })),
    { text: 'EDUCATION', style: 'sectionHeader', margin: [0, 10, 0, 4] },
    ...resume.education.map(edu => ({
      columns: [
        { text: [edu.degree, edu.institution].filter(Boolean).join(', '), style: 'body' as const, width: '*' as const },
        { text: edu.year || '', style: 'body' as const, width: 'auto' as const, alignment: 'right' as const },
      ],
      margin: [0, 2, 0, 2] as [number, number, number, number],
    })),
  ]

  return render({
    pageSize: 'LETTER',
    pageMargins: [40, 40, 40, 40],
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.3 },
    styles: STYLES,
    content,
    // A section heading never sits alone at the bottom of a page.
    // pdfmake 0.3 calls this with (nodeInfo, { getFollowingNodesOnPage, ... }).
    pageBreakBefore: (current: any, helpers: any) =>
      current?.style === 'sectionHeader' && (helpers?.getFollowingNodesOnPage?.() ?? []).length === 0,
  } as TDocumentDefinitions)
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
