'use client';

import { motion } from 'framer-motion';

const INTEGRATIONS = [
  {
    letter: 'C',
    name: 'Cursor',
    desc: 'AI-first IDE. Say "test this project" and Healix takes over.',
    status: 'Supported',
    primary: true,
  },
  {
    letter: 'W',
    name: 'Windsurf',
    desc: "Codeium's agentic IDE with full MCP support.",
    status: 'Supported',
    primary: true,
  },
  {
    letter: 'AI',
    name: 'Claude',
    desc: "Anthropic's Claude via MCP server protocol.",
    status: 'Supported',
    primary: true,
  },
  {
    letter: 'PW',
    name: 'Playwright',
    desc: 'Industry-standard browser automation and testing.',
    status: 'Built-in',
    primary: false,
  },
  {
    letter: 'AI',
    name: 'OpenAI',
    desc: 'GPT-4 powers intelligent test generation and analysis.',
    status: 'Built-in',
    primary: false,
  },
  {
    letter: 'J',
    name: 'Jira',
    desc: 'Generate tests from user stories and acceptance criteria.',
    status: 'Optional',
    primary: false,
  },
];

export default function Integrations() {
  return (
    <section className="py-24 bg-[#0a0a0a] relative" id="integrations">
      <div className="relative max-w-6xl mx-auto px-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <div className="y2k-badge mb-4">Integrations</div>
          <h2 className="text-4xl lg:text-5xl font-black text-white leading-tight mb-4 mt-4">
            Built for your AI-native stack.<br />
            <span className="text-[#a0a0a0]">Simple to connect.</span>
          </h2>
          <p className="text-[#a0a0a0] text-base max-w-xl mx-auto font-mono">
            Healix MCP plugs directly into the tools your team already uses — no migration, no disruption.
          </p>
        </motion.div>

        {/* Center logo */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          className="flex justify-center mb-10"
        >
          <div className="flex flex-col items-center gap-3">
            <div className="w-16 h-16 bg-white border-2 border-black flex items-center justify-center shadow-[4px_4px_0px_#555] animate-stamp">
              <svg width="32" height="32" viewBox="0 0 48 48" fill="none">
                <path d="M12 24l7 7 17-17" stroke="black" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span className="text-white font-black text-xs font-mono uppercase tracking-widest">HEALIX_MCP</span>
          </div>
        </motion.div>

        {/* Integration cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {INTEGRATIONS.map((integration, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ delay: i * 0.07, duration: 0.4 }}
              whileHover={{ x: -2, y: -2, boxShadow: '6px 6px 0px #ffffff', borderColor: '#ffffff' }}
              className="bg-[#111] border-2 border-[#333] shadow-[4px_4px_0px_#333] p-5 flex items-center gap-4 transition-all duration-75 group"
            >
              <div className="flex-shrink-0 w-12 h-12 bg-white border-2 border-black flex items-center justify-center font-black text-black text-sm font-mono group-hover:bg-black group-hover:text-white group-hover:border-white transition-colors duration-150">
                {integration.letter}
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-white font-black text-sm uppercase tracking-wide font-mono">{integration.name}</h4>
                <p className="text-[#a0a0a0] text-xs leading-relaxed mt-0.5 font-mono">{integration.desc}</p>
              </div>
              <span className="flex-shrink-0 y2k-badge">{integration.status}</span>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
