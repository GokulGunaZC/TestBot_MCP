import type { Metadata } from 'next'
import { Space_Grotesk, Space_Mono } from 'next/font/google'
import './globals.css'

const spaceGrotesk = Space_Grotesk({
  variable: '--font-space-grotesk',
  subsets: ['latin'],
  display: 'swap',
})

const spaceMono = Space_Mono({
  variable: '--font-space-mono',
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Healix MCP',
  description:
    'AI-powered test automation platform. Run, analyze, and manage your tests with Healix MCP.',
  keywords: ['testing', 'automation', 'AI', 'MCP', 'QA'],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body
        className={`${spaceGrotesk.variable} ${spaceMono.variable} antialiased bg-black text-white`}
        style={{ fontFamily: "var(--font-space-grotesk), 'Space Grotesk', sans-serif" }}
      >
        {children}
      </body>
    </html>
  )
}
