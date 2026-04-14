'use client';

import { motion } from 'framer-motion';

const FEATURES = [
  {
    large: true,
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" /><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14M15.54 8.46a5 5 0 010 7.07M8.46 8.46a5 5 0 000 7.07" />
      </svg>
    ),
    title: 'MCP Native Integration',
    desc: 'Runs as a Model Context Protocol server. Say "test my app" in Cursor or Windsurf and the entire pipeline kicks off — detect, generate, run, analyze, report.',
    extra: (
      <div className="mt-4 bg-black border-2 border-[#333] p-4 font-mono text-xs">
        <div className="text-[#505050]">// In your IDE chat</div>
        <div className="text-white mt-1">&quot;Test this project using healix mcp&quot;</div>
        <div className="text-[#a0a0a0] mt-2">&gt; Auto-detects config...</div>
        <div className="text-[#a0a0a0]">&gt; Generating 12 tests...</div>
        <div className="text-white font-bold">&gt; + 11 passed, 1 analyzed</div>
      </div>
    ),
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    ),
    title: 'Zero-Config Setup',
    desc: 'Auto-detects your framework, port, and start command. Works with React, Next.js, Express, Django, FastAPI, and more out of the box.',
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v3" />
        <path d="M15 13v-2a3 3 0 00-6 0v2" />
      </svg>
    ),
    title: 'AI Test Generation',
    desc: 'No existing tests? OpenAI analyzes your codebase structure and generates comprehensive Playwright test suites covering pages, forms, APIs, and auth flows.',
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
    title: 'AI Failure Analysis',
    desc: 'When tests fail, AI providers (Sarvam, OpenAI, Cascade) diagnose root causes and generate actionable fix suggestions — not just stack traces.',
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="0" /><path d="M3 9h18M9 21V9" />
      </svg>
    ),
    title: 'Interactive Dashboard',
    desc: 'Beautiful browser-based dashboard with KPI cards, pass/fail charts, sortable test tables, and built-in screenshot/video/trace viewers.',
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
    title: 'Jira Integration',
    desc: 'Connect your Jira project and Healix automatically fetches user stories, generating tests directly from acceptance criteria.',
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M15 10l-4 4l6 6l4-16l-18 7l4 2l2 6l2-4" />
      </svg>
    ),
    title: 'Multi-Browser Testing',
    desc: 'Run tests across Chrome, Firefox, and Safari in parallel. Capture screenshots on failure, record videos, and generate Playwright trace files.',
  },
  {
    large: true,
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    title: 'Multiple AI Providers',
    desc: 'Plug in your preferred AI backend. Healix supports Sarvam AI, OpenAI GPT-4, Cascade, and Windsurf — switchable with a single env variable.',
    extra: (
      <div className="mt-4 flex flex-wrap gap-2">
        {['Sarvam AI', 'OpenAI', 'Cascade', 'Windsurf'].map(p => (
          <span key={p} className="y2k-badge">{p}</span>
        ))}
      </div>
    ),
  },
];

export default function Features() {
  return (
    <section className="py-24 bg-black relative" id="features">
      <div className="max-w-6xl mx-auto px-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <div className="y2k-badge mb-4">Features</div>
          <h2 className="text-4xl lg:text-5xl font-black text-white leading-tight mb-4 mt-4">
            Everything you need.<br />
            <span className="text-[#a0a0a0]">Nothing you don&apos;t.</span>
          </h2>
          <p className="text-[#a0a0a0] text-base max-w-xl mx-auto font-mono">
            Healix MCP is purpose-built for AI-native development teams who want testing to just work.
          </p>
        </motion.div>

        {/* Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((feat, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ delay: (i % 3) * 0.08, duration: 0.4 }}
              whileHover={{ x: -2, y: -2, boxShadow: '6px 6px 0px #ffffff', borderColor: '#ffffff' }}
              className={`relative bg-[#111] border-2 border-[#333] shadow-[4px_4px_0px_#333] p-6 group cursor-default overflow-hidden transition-all duration-75 ${feat.large ? 'md:col-span-2 lg:col-span-1' : ''}`}
            >
              {/* Top accent line on hover */}
              <div className="absolute top-0 left-0 right-0 h-0.5 bg-white scale-x-0 group-hover:scale-x-100 transition-transform duration-200 origin-left" />

              <div className="relative">
                <div className="w-10 h-10 border-2 border-white bg-black flex items-center justify-center text-white mb-4 group-hover:bg-white group-hover:text-black transition-colors duration-150">
                  {feat.icon}
                </div>
                <h3 className="text-white font-black text-base mb-2 uppercase tracking-wide">{feat.title}</h3>
                <p className="text-[#a0a0a0] text-sm leading-relaxed font-mono">{feat.desc}</p>
                {feat.extra}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
