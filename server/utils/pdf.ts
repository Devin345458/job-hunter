import { createRequire } from 'module'
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces'
import type { TailoredResume } from './ai'

const require = createRequire(import.meta.url)

function getPrinter() {
  const PdfPrinter = require('pdfmake')
  const fonts = {
    Helvetica: {
      normal: 'Helvetica',
      bold: 'Helvetica-Bold',
      italics: 'Helvetica-Oblique',
      bolditalics: 'Helvetica-BoldOblique',
    },
  }
  return new PdfPrinter(fonts)
}

export function generateResumePdf(
  resume: TailoredResume,
  candidateName: string,
  contactInfo: { email?: string; phone?: string; location?: string; linkedin?: string; github?: string },
): Promise<Buffer> {
  const contactLine = [
    contactInfo.email,
    contactInfo.phone,
    contactInfo.location,
    contactInfo.linkedin,
    contactInfo.github,
  ].filter(Boolean).join('  |  ')

  const content: Content = [
    { text: candidateName, style: 'name', alignment: 'center' },
    { text: contactLine, style: 'contactInfo', alignment: 'center', margin: [0, 2, 0, 10] },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: '#333333' }], margin: [0, 0, 0, 10] },
    { text: 'PROFESSIONAL SUMMARY', style: 'sectionHeader' },
    { text: resume.summary, style: 'body', margin: [0, 4, 0, 12] },
    { text: 'EXPERIENCE', style: 'sectionHeader' },
    ...resume.experience.flatMap((exp) => [
      {
        columns: [
          { text: `${exp.title} — ${exp.company}`, style: 'jobTitle', width: '*' },
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
    ...resume.education.map((edu) => ({
      columns: [
        { text: `${edu.degree} — ${edu.institution}`, style: 'body' as const, width: '*' as const },
        { text: edu.year, style: 'body' as const, width: 'auto' as const, alignment: 'right' as const },
      ],
      margin: [0, 2, 0, 2] as [number, number, number, number],
    })),
  ]

  const docDefinition: TDocumentDefinitions = {
    pageSize: 'LETTER',
    pageMargins: [40, 40, 40, 40],
    defaultStyle: {
      font: 'Helvetica',
      fontSize: 10,
      lineHeight: 1.3,
    },
    styles: {
      name: { fontSize: 18, bold: true, color: '#1a1a1a' },
      contactInfo: { fontSize: 9, color: '#555555' },
      sectionHeader: { fontSize: 11, bold: true, color: '#1a1a1a', margin: [0, 8, 0, 4] },
      jobTitle: { fontSize: 10, bold: true, color: '#333333' },
      jobPeriod: { fontSize: 9, color: '#666666', italics: true },
      body: { fontSize: 10, color: '#333333' },
    },
    content,
  }

  const printer = getPrinter()
  const pdfDoc = printer.createPdfKitDocument(docDefinition)
  const chunks: Buffer[] = []

  return new Promise<Buffer>((resolve, reject) => {
    pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk))
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)))
    pdfDoc.on('error', reject)
    pdfDoc.end()
  })
}

export async function saveResumePdf(
  resume: TailoredResume,
  candidateName: string,
  contactInfo: { email?: string; phone?: string; location?: string; linkedin?: string; github?: string },
  outputPath: string,
): Promise<string> {
  const dir = dirname(outputPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const buffer = await generateResumePdf(resume, candidateName, contactInfo)
  writeFileSync(outputPath, buffer)
  return outputPath
}
