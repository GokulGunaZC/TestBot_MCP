import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { testRuns } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'

type ReportArtifact = {
  path?: string
  fullPath?: string
  name?: string
}

type ReportAttachmentGroup = {
  screenshots?: ReportArtifact[]
  videos?: ReportArtifact[]
  traces?: ReportArtifact[]
  other?: ReportArtifact[]
}

type ReportTestEntry = {
  attachments?: ReportAttachmentGroup
  artifacts?: ReportAttachmentGroup
  errorDetail?: {
    attachments?: ReportAttachmentGroup
  }
}

type ReportPayload = {
  tests?: ReportTestEntry[]
  results?: ReportTestEntry[]
  metadata?: {
    projectPath?: string
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
  '.trace': 'application/zip',
  '.json': 'application/json',
  '.html': 'text/html',
  '.txt': 'text/plain',
  '.log': 'text/plain',
}

const PATH_ROOTS = [
  '',
  'testbot-reports',
  path.join('testbot-reports', 'artifacts'),
  'test-results',
  'playwright-report',
]

function normalizeRequestPath(filePath: string): string | null {
  const decoded = decodeURIComponent(filePath).trim()
  if (!decoded) return null

  const normalized = path.normalize(decoded).replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('..')) {
    return null
  }
  return normalized
}

function collectArtifacts(reportJson: ReportPayload | null | undefined): ReportArtifact[] {
  const artifacts: ReportArtifact[] = []
  const attachmentKeys: Array<keyof ReportAttachmentGroup> = ['screenshots', 'videos', 'traces', 'other']
  const tests = [
    ...(Array.isArray(reportJson?.tests) ? reportJson.tests : []),
    ...(Array.isArray(reportJson?.results) ? reportJson.results : []),
  ]

  for (const test of tests) {
    const groups = [
      test?.attachments,
      test?.artifacts,
      test?.errorDetail?.attachments,
    ]

    for (const group of groups) {
      if (!group || typeof group !== 'object') continue
      for (const key of attachmentKeys) {
        const entries = Array.isArray(group[key]) ? group[key] : []
        for (const entry of entries) {
          artifacts.push({
            path: entry?.path,
            fullPath: entry?.fullPath,
            name: entry?.name,
          })
        }
      }
    }
  }

  return artifacts
}

function addCandidate(candidates: Set<string>, candidate: string | null | undefined) {
  if (!candidate) return
  const trimmed = String(candidate).trim()
  if (!trimmed) return
  candidates.add(trimmed)
}

function buildCandidates(requestedPath: string, projectPath: string, reportJson: ReportPayload | null | undefined): string[] {
  const candidates = new Set<string>()

  if (path.isAbsolute(requestedPath)) {
    addCandidate(candidates, requestedPath)
  }

  for (const root of PATH_ROOTS) {
    addCandidate(candidates, path.resolve(projectPath, root, requestedPath))
  }

  if (requestedPath.startsWith('artifacts/')) {
    const withoutArtifactsPrefix = requestedPath.replace(/^artifacts\//, '')
    addCandidate(candidates, path.resolve(projectPath, 'testbot-reports', 'artifacts', withoutArtifactsPrefix))
  }

  if (requestedPath.startsWith('testbot-reports/')) {
    const withoutReportPrefix = requestedPath.replace(/^testbot-reports\//, '')
    addCandidate(candidates, path.resolve(projectPath, withoutReportPrefix))
  }

  const requestedBaseName = path.basename(requestedPath)
  const reportArtifacts = collectArtifacts(reportJson)

  for (const artifact of reportArtifacts) {
    const values = [artifact.path, artifact.fullPath, artifact.name].filter(Boolean) as string[]
    for (const value of values) {
      const normalizedValue = path.normalize(value).replace(/\\/g, '/').replace(/^\/+/, '')
      if (!normalizedValue) continue

      const valueBaseName = path.basename(normalizedValue)
      const isMatch =
        normalizedValue === requestedPath ||
        normalizedValue.endsWith(`/${requestedPath}`) ||
        valueBaseName === requestedBaseName

      if (!isMatch) continue

      addCandidate(candidates, artifact.fullPath)
      addCandidate(candidates, artifact.path)
      addCandidate(candidates, path.resolve(projectPath, artifact.path || ''))
      addCandidate(candidates, path.resolve(projectPath, 'testbot-reports', artifact.path || ''))
      addCandidate(candidates, path.resolve(projectPath, 'testbot-reports', 'artifacts', artifact.path || ''))
    }
  }

  return [...candidates]
}

function realPathIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null
    if (!fs.statSync(filePath).isFile()) return null
    return fs.realpathSync(filePath)
  } catch {
    return null
  }
}

function isWithinAllowedRoots(realCandidate: string, projectPath: string): boolean {
  const possibleRoots = [
    projectPath,
    process.cwd(),
    path.join(projectPath, 'testbot-reports'),
    path.join(projectPath, 'test-results'),
    path.join(projectPath, 'playwright-report'),
  ]
  const realRoots = possibleRoots
    .map((root) => {
      try {
        return fs.realpathSync(root)
      } catch {
        return null
      }
    })
    .filter(Boolean) as string[]

  return realRoots.some((root) => realCandidate === root || realCandidate.startsWith(`${root}${path.sep}`))
}

function createStandardFileResponse(resolvedPath: string, contentType: string) {
  const buffer = fs.readFileSync(resolvedPath)
  return new NextResponse(buffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(buffer.length),
      'Cache-Control': 'private, max-age=3600',
    },
  })
}

function createVideoRangeResponse(request: NextRequest, resolvedPath: string, contentType: string) {
  const stat = fs.statSync(resolvedPath)
  const rangeHeader = request.headers.get('range')

  if (!rangeHeader) {
    return createStandardFileResponse(resolvedPath, contentType)
  }

  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/i)
  if (!match) {
    return new NextResponse('Invalid range header', { status: 416 })
  }

  const parsedStart = match[1] ? parseInt(match[1], 10) : 0
  const parsedEnd = match[2] ? parseInt(match[2], 10) : stat.size - 1
  const start = Number.isFinite(parsedStart) ? parsedStart : 0
  const end = Number.isFinite(parsedEnd) ? Math.min(parsedEnd, stat.size - 1) : stat.size - 1

  if (start < 0 || end < start || start >= stat.size) {
    return new NextResponse('Requested range not satisfiable', {
      status: 416,
      headers: {
        'Content-Range': `bytes */${stat.size}`,
      },
    })
  }

  const chunkSize = end - start + 1
  const stream = fs.createReadStream(resolvedPath, { start, end })
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream

  return new NextResponse(webStream, {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(chunkSize),
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    },
  })
}

/**
 * Serve Playwright artifacts (screenshots, videos, traces) from the filesystem.
 * Query params:
 *   testRunId  - the DB test run ID (for auth)
 *   file       - relative path inside testbot-reports/artifacts/ or test-results/
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const testRunId = searchParams.get('testRunId')
  const filePath = searchParams.get('file')

  if (!testRunId || !filePath) {
    return NextResponse.json({ error: 'Missing testRunId or file' }, { status: 400 })
  }

  // Verify user owns this test run
  const [row] = await db
    .select({ id: testRuns.id, reportJson: testRuns.reportJson })
    .from(testRuns)
    .where(and(eq(testRuns.id, testRunId), eq(testRuns.userId, user.id)))
    .limit(1)

  if (!row) {
    return NextResponse.json({ error: 'Test run not found' }, { status: 404 })
  }

  const reportJson = (row.reportJson || null) as ReportPayload | null

  // Get project path from report metadata
  const projectPath = reportJson?.metadata?.projectPath
  if (!projectPath) {
    return NextResponse.json({ error: 'No project path in report' }, { status: 404 })
  }

  const normalized = normalizeRequestPath(filePath)
  if (!normalized) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }

  const candidatePaths = buildCandidates(normalized, projectPath, reportJson)

  let resolvedPath: string | null = null
  for (const candidate of candidatePaths) {
    const realCandidate = realPathIfExists(candidate)
    if (!realCandidate) continue

    if (isWithinAllowedRoots(realCandidate, projectPath)) {
      resolvedPath = realCandidate
      break
    }
  }

  if (!resolvedPath) {
    return NextResponse.json(
      {
        error: 'File not found',
        requestedPath: normalized,
      },
      { status: 404 }
    )
  }

  const ext = path.extname(resolvedPath).toLowerCase()
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream'

  if (contentType.startsWith('video/')) {
    return createVideoRangeResponse(request, resolvedPath, contentType)
  }

  return createStandardFileResponse(resolvedPath, contentType)
}
