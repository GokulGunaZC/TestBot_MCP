'use client';

import { useRef } from 'react';
import { motion } from 'framer-motion';

export default function DashboardPreview() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mockupRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: React.MouseEvent) => {
    const wrapper = wrapperRef.current;
    const mockup = mockupRef.current;
    if (!wrapper || !mockup) return;
    const rect = wrapper.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = (e.clientX - cx) / rect.width;
    const dy = (e.clientY - cy) / rect.height;
    const rx = -dy * 5;
    const ry = dx * 5;
    mockup.style.transform = `perspective(1200px) rotateX(${rx}deg) rotateY(${ry}deg)`;
  };

  const handleMouseLeave = () => {
    if (mockupRef.current) {
      mockupRef.current.style.transform = 'perspective(1200px) rotateX(3deg) rotateY(0deg)';
    }
  };

  return (
    <section className="py-24 bg-black relative" id="dashboard">
      <div className="relative max-w-6xl mx-auto px-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <div className="y2k-badge mb-4">Dashboard</div>
          <h2 className="text-4xl lg:text-5xl font-black text-white leading-tight mb-4 mt-4">
            Understand your test results<br />
            <span className="text-[#a0a0a0]">at a glance.</span>
          </h2>
          <p className="text-[#a0a0a0] text-base max-w-xl mx-auto font-mono">
            Every test run opens a rich, interactive dashboard. No more digging through terminal logs.
          </p>
        </motion.div>

        {/* Dashboard mockup with 3D tilt */}
        <motion.div
          ref={wrapperRef}
          initial={{ opacity: 0, y: 32 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7 }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          className="relative cursor-default"
          style={{ perspective: '1200px' }}
        >
          <div
            ref={mockupRef}
            className="brutal-card overflow-hidden"
            style={{ transform: 'perspective(1200px) rotateX(3deg) rotateY(0deg)', transition: 'transform 0.1s ease' }}
          >
            {/* Browser bar */}
            <div className="flex items-center gap-3 px-4 py-3 border-b-2 border-[#333] bg-[#0a0a0a]">
              <div className="flex gap-1.5">
                <span className="w-3 h-3 border-2 border-[#555] bg-[#333]" />
                <span className="w-3 h-3 border-2 border-[#555] bg-[#555]" />
                <span className="w-3 h-3 border-2 border-[#555] bg-white" />
              </div>
              <div className="flex-1 mx-8">
                <div className="bg-[#111] border-2 border-[#333] px-3 py-1 text-[#505050] text-xs text-center font-mono">
                  localhost:3001/dashboard
                </div>
              </div>
            </div>

            {/* Dashboard content */}
            <div className="p-6 bg-black">
              {/* Header row */}
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-white font-black text-base uppercase tracking-wide font-mono">Healix MCP — Test Results</h3>
                  <span className="text-[#505050] text-xs font-mono">Run 5 mins ago</span>
                </div>
                <span className="y2k-badge">
                  <span className="inline-block w-1.5 h-1.5 bg-white" style={{ animation: 'crt-flicker 1.5s ease-in-out infinite' }} />
                  Live
                </span>
              </div>

              {/* KPI cards */}
              <div className="grid grid-cols-4 gap-3 mb-6">
                <div className="bg-[#111] border-2 border-[#333] shadow-[2px_2px_0px_#555] p-4">
                  <div className="text-3xl font-black text-white mb-1 font-mono">47</div>
                  <div className="text-[#a0a0a0] text-xs mb-2 font-mono uppercase tracking-wider">Passed</div>
                  <div className="h-1 bg-[#222] overflow-hidden">
                    <div className="h-full bg-white" style={{ width: '94%' }} />
                  </div>
                </div>
                <div className="bg-[#111] border-2 border-[#333] shadow-[2px_2px_0px_#555] p-4">
                  <div className="text-3xl font-black text-[#a0a0a0] mb-1 font-mono">3</div>
                  <div className="text-[#a0a0a0] text-xs mb-2 font-mono uppercase tracking-wider">Failed</div>
                  <div className="h-1 bg-[#222] overflow-hidden">
                    <div className="h-full bg-[#555]" style={{ width: '6%' }} />
                  </div>
                </div>
                <div className="bg-[#111] border-2 border-[#333] shadow-[2px_2px_0px_#555] p-4 flex items-center gap-3">
                  <div>
                    <div className="text-3xl font-black text-white mb-1 font-mono">94%</div>
                    <div className="text-[#a0a0a0] text-xs font-mono uppercase tracking-wider">Pass Rate</div>
                  </div>
                  <svg viewBox="0 0 36 36" className="w-10 h-10 -rotate-90">
                    <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#333" strokeWidth="3" />
                    <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="white" strokeWidth="3" strokeDasharray="94, 100" />
                  </svg>
                </div>
                <div className="bg-[#111] border-2 border-[#333] shadow-[2px_2px_0px_#555] p-4">
                  <div className="text-3xl font-black text-white mb-1 font-mono">3.2s</div>
                  <div className="text-[#a0a0a0] text-xs font-mono uppercase tracking-wider">Avg Time</div>
                </div>
              </div>

              {/* Test table */}
              <div className="bg-[#0a0a0a] border-2 border-[#333] overflow-hidden mb-4">
                {[
                  { pass: true,  name: 'Homepage loads correctly',       suite: 'UI Tests',   time: '1.2s' },
                  { pass: true,  name: 'User login flow',                suite: 'Auth Tests', time: '2.8s' },
                  { pass: false, name: 'Checkout form validation',       suite: 'E2E Tests',  time: '4.1s' },
                  { pass: true,  name: 'API /users endpoint returns 200',suite: 'API Tests',  time: '0.4s' },
                  { pass: true,  name: 'Product search filters',         suite: 'UI Tests',   time: '3.6s' },
                ].map((row, i) => (
                  <div key={i} className={`flex items-center gap-4 px-4 py-2.5 border-b border-[#1a1a1a] last:border-0 text-xs ${row.pass ? '' : 'bg-[#1a1a1a]'}`}>
                    <span className={`font-black font-mono ${row.pass ? 'text-white' : 'text-[#a0a0a0]'}`}>{row.pass ? '+' : '!'}</span>
                    <span className="text-white flex-1 font-mono">{row.name}</span>
                    <span className="text-[#505050] text-xs font-mono uppercase">{row.suite}</span>
                    <span className="text-[#a0a0a0] text-xs font-mono">{row.time}</span>
                  </div>
                ))}
              </div>

              {/* AI Analysis */}
              <div className="bg-[#0a0a0a] border-2 border-[#333] p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="y2k-badge">AI Analysis</span>
                  <span className="text-[#505050] text-xs font-mono">Sarvam AI</span>
                </div>
                <p className="text-[#a0a0a0] text-xs leading-relaxed font-mono">
                  Checkout form validation failed because{' '}
                  <code className="text-white bg-[#1a1a1a] border border-[#333] px-1 py-0.5 text-xs">data-testid=&quot;submit-btn&quot;</code>{' '}
                  is not present. Use{' '}
                  <code className="text-white bg-[#1a1a1a] border border-[#333] px-1 py-0.5 text-xs">getByRole(&apos;button&apos;, &#123; name: &apos;Place Order&apos; &#125;)</code>{' '}
                  instead.
                </p>
              </div>
            </div>
          </div>

          {/* Hard shadow below */}
          <div className="absolute -bottom-3 left-3 right-3 h-3 bg-[#333]" style={{ zIndex: -1 }} />
        </motion.div>
      </div>
    </section>
  );
}
