import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

const PROTECTED_ROUTES = [
  '/home',
  '/mcp-tests',
  '/create-tests',
  '/all-tests',
  '/test-lists',
  '/monitoring',
  '/profile',
  '/plan-billing',
  '/api-keys',
]

const AUTH_ROUTES = ['/login', '/signup', '/forgot-password']

async function getSessionUser(request: NextRequest): Promise<{ userId: string } | null> {
  const token = request.cookies.get('testbot-session')?.value
  if (!token) return null

  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET)
    const { payload } = await jwtVerify(token, secret)
    if (!payload.sub) return null
    return { userId: payload.sub }
  } catch {
    return null
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const session = await getSessionUser(request)

  const isProtected = PROTECTED_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + '/')
  )
  const isAuthRoute = AUTH_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + '/')
  )

  if (isProtected && !session) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.searchParams.set('redirectedFrom', pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (isAuthRoute && session) {
    const homeUrl = request.nextUrl.clone()
    homeUrl.pathname = '/home'
    homeUrl.search = ''
    return NextResponse.redirect(homeUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
