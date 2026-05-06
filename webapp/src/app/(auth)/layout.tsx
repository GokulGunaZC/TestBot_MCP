import { ReactNode } from 'react'

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-bg-darkest">
      {/* Animated gradient orbs */}
      <div
        className="glow-orb animate-orb-1 w-[500px] h-[500px] bg-blue-600"
        style={{ top: '-120px', left: '-160px' }}
      />
      <div
        className="glow-orb animate-orb-2 w-[400px] h-[400px] bg-cyan-500"
        style={{ bottom: '-80px', right: '-120px', opacity: 0.25 }}
      />
      <div
        className="glow-orb w-[300px] h-[300px] bg-blue-800"
        style={{ top: '40%', left: '60%', opacity: 0.2 }}
      />

      {/* Dot grid overlay */}
      <div className="absolute inset-0 dot-grid opacity-40 pointer-events-none" />

      {/* Centered content */}
      <main className="relative z-10 w-full flex items-center justify-center p-4">
        {children}
      </main>
    </div>
  )
}
