'use client';

import { motion } from 'framer-motion';

const STEPS = [
  {
    num: '01',
    title: 'Auto-Detect',
    desc: 'Healix scans your package.json, playwright.config.js, and environment to detect framework, port, start command, and base URL. Zero config needed.',
    tags: ['React', 'Next.js', 'Express', 'Django', '+more'],
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
      </svg>
    ),
  },
  {
    num: '02',
    title: 'AI Test Generation',
    desc: 'No tests? No problem. Healix analyzes your codebase — pages, API endpoints, forms, auth flows — and generates comprehensive Playwright tests using OpenAI.',
    tags: ['OpenAI GPT-4', 'Playwright', 'Jira Stories'],
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    ),
  },
  {
    num: '03',
    title: 'Execute & Capture',
    desc: 'Tests run across browsers with full artifact capture — screenshots on failure, video recordings, and Playwright traces for deep debugging.',
    tags: ['Chrome', 'Firefox', 'Safari', 'Screenshots', 'Videos'],
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="5 3 19 12 5 21 5 3" />
      </svg>
    ),
  },
  {
    num: '04',
    title: 'AI Analysis & Dashboard',
    desc: 'Failures are analyzed with AI (Sarvam, OpenAI) for root cause explanations. Results open in an interactive dashboard with KPI cards, charts, and artifact viewers.',
    tags: ['Sarvam AI', 'OpenAI', 'Dashboard'],
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
];

export default function HowItWorks() {
  return (
    <section className="py-24 bg-[#0a0a0a] relative" id="how-it-works">
      <div className="max-w-6xl mx-auto px-6">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <div className="y2k-badge mb-4">How it works</div>
          <h2 className="text-4xl lg:text-5xl font-black text-white leading-tight mb-4 mt-4">
            One command.<br />
            <span className="text-[#a0a0a0]">Fully autonomous testing.</span>
          </h2>
          <p className="text-[#a0a0a0] text-base max-w-2xl mx-auto leading-relaxed font-mono">
            Healix MCP orchestrates your entire testing pipeline from a single natural language prompt — no setup scripts, no YAML configs, no manual effort.
          </p>
        </motion.div>

        {/* Pipeline steps */}
        <div className="flex flex-col gap-4">
          {STEPS.map((step, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -16 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ delay: i * 0.1, duration: 0.4 }}
              whileHover={{ x: -2, y: -2, boxShadow: '6px 6px 0px #ffffff', borderColor: '#ffffff' }}
              className="relative flex gap-6 bg-[#111] border-2 border-[#333] shadow-[4px_4px_0px_#333] p-6 group cursor-default transition-all duration-75"
            >
              {/* Left accent bar */}
              <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-white scale-y-0 group-hover:scale-y-100 transition-transform duration-200 origin-top" />

              {/* Step number + icon */}
              <div className="flex-shrink-0 flex flex-col items-center gap-2">
                <div className="w-12 h-12 bg-white text-black border-2 border-black flex items-center justify-center group-hover:bg-black group-hover:text-white group-hover:border-white transition-colors duration-150">
                  {step.icon}
                </div>
                <span className="text-[#505050] text-xs font-black font-mono">{step.num}</span>
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <h3 className="text-white font-black text-lg mb-2 uppercase tracking-wide">{step.title}</h3>
                <p className="text-[#a0a0a0] text-sm leading-relaxed mb-4 font-mono">{step.desc}</p>
                <div className="flex flex-wrap gap-2">
                  {step.tags.map((tag) => (
                    <span key={tag} className="y2k-badge">{tag}</span>
                  ))}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
