'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';

const TERMINAL_MESSAGE = 'Test this project using healix mcp';

const OUTPUT_LINES = [
  { icon: '>', text: 'Auto-detecting project configuration...', cls: 'text-[#a0a0a0]', delay: 0 },
  { icon: '+', text: 'Detected: Next.js on port 3000', cls: 'text-white font-bold', delay: 600 },
  { icon: '>', text: 'Generating tests with OpenAI GPT-4...', cls: 'text-[#a0a0a0]', delay: 1200 },
  { icon: '+', text: '14 test files generated', cls: 'text-white font-bold', delay: 2000 },
  { icon: '>', text: 'Running Playwright across 3 browsers...', cls: 'text-[#a0a0a0]', delay: 2600 },
  { icon: '+', text: '47 tests passed', cls: 'text-white font-bold', delay: 4000 },
  { icon: '!', text: '3 tests failed — analyzing with AI', cls: 'text-[#d0d0d0]', delay: 4200 },
  { icon: '>', text: 'Opening dashboard in browser...', cls: 'text-[#a0a0a0]', delay: 5000 },
  { icon: '+', text: 'Done! Report ready at localhost:3001', cls: 'text-white font-bold', delay: 5600 },
];

export default function Hero() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [typedText, setTypedText] = useState('');
  const [outputLines, setOutputLines] = useState<typeof OUTPUT_LINES>([]);
  const terminalRef = useRef<HTMLDivElement>(null);

  // B&W particle / grid canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    interface Particle { x: number; y: number; r: number; vx: number; vy: number; o: number }
    let particles: Particle[] = [];
    let W = 0, H = 0;

    function resize() {
      W = canvas!.width = canvas!.offsetWidth;
      H = canvas!.height = canvas!.offsetHeight;
    }

    function createParticles() {
      particles = [];
      const count = Math.floor((W * H) / 18000);
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * W, y: Math.random() * H,
          r: Math.random() * 1.2 + 0.3,
          vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18,
          o: Math.random() * 0.4 + 0.08,
        });
      }
    }

    function draw() {
      ctx!.clearRect(0, 0, W, H);
      // Draw connection lines
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 110) {
            ctx!.beginPath();
            ctx!.strokeStyle = `rgba(255,255,255,${0.10 * (1 - dist / 110)})`;
            ctx!.lineWidth = 0.5;
            ctx!.moveTo(particles[i].x, particles[i].y);
            ctx!.lineTo(particles[j].x, particles[j].y);
            ctx!.stroke();
          }
        }
      }
      // Draw particles
      particles.forEach(p => {
        ctx!.beginPath();
        ctx!.rect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2); // square pixels
        ctx!.fillStyle = `rgba(255,255,255,${p.o})`;
        ctx!.fill();
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > W) p.vx *= -1;
        if (p.y < 0 || p.y > H) p.vy *= -1;
      });
      animId = requestAnimationFrame(draw);
    }

    const ro = new ResizeObserver(() => { resize(); createParticles(); });
    ro.observe(canvas);
    resize(); createParticles(); draw();

    return () => { cancelAnimationFrame(animId); ro.disconnect(); };
  }, []);

  // Terminal typing animation
  useEffect(() => {
    let cancelled = false;
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    function runSequence() {
      setTypedText('');
      setOutputLines([]);
      let charIdx = 0;

      function typeChar() {
        if (cancelled) return;
        if (charIdx < TERMINAL_MESSAGE.length) {
          setTypedText(TERMINAL_MESSAGE.slice(0, charIdx + 1));
          charIdx++;
          const t = setTimeout(typeChar, 42 + Math.random() * 28);
          timeouts.push(t);
        } else {
          OUTPUT_LINES.forEach((line) => {
            const t = setTimeout(() => {
              if (cancelled) return;
              setOutputLines(prev => [...prev, line]);
              if (terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
            }, 300 + line.delay);
            timeouts.push(t);
          });
          const resetDelay = 300 + OUTPUT_LINES[OUTPUT_LINES.length - 1].delay + 3000;
          const t = setTimeout(() => { if (!cancelled) runSequence(); }, resetDelay);
          timeouts.push(t);
        }
      }

      const t = setTimeout(typeChar, 1200);
      timeouts.push(t);
    }

    runSequence();
    return () => { cancelled = true; timeouts.forEach(clearTimeout); };
  }, []);

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-16 bg-black" id="hero">
      {/* B&W Background */}
      <div className="absolute inset-0">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
        {/* CRT-style grid */}
        <div className="absolute inset-0 opacity-30"
          style={{
            backgroundImage: `linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)`,
            backgroundSize: '40px 40px',
          }}
        />
        {/* Subtle noise orbs */}
        <div className="glow-orb animate-orb-1 w-80 h-80 top-20 -left-24" />
        <div className="glow-orb animate-orb-2 w-64 h-64 bottom-24 right-0" />
        {/* Scanline sweep */}
        <div
          className="absolute left-0 right-0 h-32 pointer-events-none"
          style={{
            background: 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.03), transparent)',
            animation: 'scanline 8s linear infinite',
          }}
        />
      </div>

      <div className="relative max-w-7xl mx-auto px-6 w-full grid lg:grid-cols-2 gap-16 items-center py-20">
        {/* Left: Copy */}
        <motion.div
          initial={{ opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="flex flex-col gap-6"
        >
          {/* Y2K Badge */}
          <motion.div
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 }}
            className="y2k-badge w-fit"
          >
            <span className="inline-block w-2 h-2 bg-white" style={{ animation: 'crt-flicker 2s ease-in-out infinite' }} />
            Now in Beta — Free for developers
          </motion.div>

          {/* Heading */}
          <div className="flex flex-col gap-1">
            <motion.h1
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.6 }}
              className="text-5xl lg:text-6xl font-black text-white leading-tight tracking-tighter glitch"
              data-text="10x your dev speed"
            >
              10x your dev speed
            </motion.h1>
            <motion.span
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.6 }}
              className="text-5xl lg:text-6xl font-black text-[#a0a0a0] leading-tight tracking-tighter"
            >
              with AI-native testing
            </motion.span>
          </div>

          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.5 }}
            className="text-[#a0a0a0] text-lg leading-relaxed max-w-xl font-mono"
          >
            Healix MCP is the missing verification layer of the agentic workflow. One command — auto-detect, generate, run, and analyze tests.
          </motion.p>

          {/* CTAs */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="flex flex-wrap gap-3"
          >
            <Link href="/home" className="btn-gradient flex items-center gap-2 px-6 py-3 text-sm">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Start Testing Free
            </Link>
            <a
              href="#how-it-works"
              className="flex items-center gap-2 text-white font-bold px-6 py-3 text-sm font-mono border-2 border-white hover:bg-white hover:text-black transition-all uppercase tracking-widest"
            >
              How it works
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </a>
          </motion.div>

          {/* Social proof */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7 }}
            className="flex items-center gap-3"
          >
            <div className="flex -space-x-2">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="w-8 h-8 border-2 border-black bg-white flex items-center justify-center text-xs text-black font-bold font-mono">
                  {String.fromCharCode(64 + i)}
                </div>
              ))}
            </div>
            <p className="text-[#a0a0a0] text-sm font-mono">
              Used by <strong className="text-white">500+</strong> developers worldwide
            </p>
          </motion.div>
        </motion.div>

        {/* Right: Terminal */}
        <motion.div
          initial={{ opacity: 0, x: 32 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.4, duration: 0.7 }}
          className="relative"
        >
          {/* Terminal window */}
          <div className="brutal-card overflow-hidden">
            {/* Title bar */}
            <div className="flex items-center gap-3 px-4 py-3 border-b-2 border-[#333] bg-[#0a0a0a]">
              <div className="flex gap-1.5">
                <span className="w-3 h-3 border-2 border-[#555] bg-[#333]" />
                <span className="w-3 h-3 border-2 border-[#555] bg-[#555]" />
                <span className="w-3 h-3 border-2 border-[#555] bg-white" />
              </div>
              <span className="text-[#505050] text-xs font-mono mx-auto tracking-widest uppercase">
                [ Cursor IDE — Healix MCP ]
              </span>
            </div>

            {/* Body */}
            <div className="p-4 font-mono text-sm bg-black" style={{ minHeight: '280px' }}>
              {/* Prompt line */}
              <div className="flex items-start gap-2 mb-3">
                <span className="text-white font-bold shrink-0 select-none">$&gt;</span>
                <span className="text-[#d0d0d0]">
                  {typedText}
                  <span
                    className="inline-block w-2 h-4 bg-white ml-0.5 align-middle"
                    style={{ animation: 'crt-flicker 1s step-end infinite' }}
                  />
                </span>
              </div>

              {/* Output */}
              <div ref={terminalRef} className="flex flex-col gap-1 max-h-48 overflow-y-auto">
                {outputLines.map((line, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    className={`flex items-start gap-2 ${line.cls} text-xs`}
                  >
                    <span className="shrink-0 w-3 font-bold">{line.icon}</span>
                    <span>{line.text}</span>
                  </motion.div>
                ))}
              </div>
            </div>
          </div>

          {/* Floating stat badges — brutal style */}
          <motion.div
            animate={{ y: [0, -6, 0] }}
            transition={{ repeat: Infinity, duration: 3, ease: 'easeInOut' }}
            className="absolute -top-4 -right-4 brutal-card-white px-3 py-2 flex items-center gap-2"
          >
            <span className="font-black text-lg leading-none">✓</span>
            <div>
              <div className="font-black text-sm leading-none">47</div>
              <div className="text-[#555] text-xs font-mono">Tests Passed</div>
            </div>
          </motion.div>

          <motion.div
            animate={{ y: [0, 5, 0] }}
            transition={{ repeat: Infinity, duration: 3.5, ease: 'easeInOut', delay: 0.5 }}
            className="absolute top-1/3 -left-6 brutal-card-white px-3 py-2 flex items-center gap-2"
          >
            <span className="text-lg font-black leading-none">#</span>
            <div>
              <div className="font-black text-sm leading-none">3.2s</div>
              <div className="text-[#555] text-xs font-mono">Avg Run Time</div>
            </div>
          </motion.div>

          <motion.div
            animate={{ y: [0, -5, 0] }}
            transition={{ repeat: Infinity, duration: 4, ease: 'easeInOut', delay: 1 }}
            className="absolute -bottom-4 -left-4 brutal-card-white px-3 py-2 flex items-center gap-2"
          >
            <span className="text-lg font-black leading-none">AI</span>
            <div>
              <div className="font-black text-sm leading-none">GPT-4</div>
              <div className="text-[#555] text-xs font-mono">Failure Analysis</div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
