'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';

interface Stat {
  value: number | null;
  suffix: string;
  display?: string;
  desc: string;
  sub: string;
}

const STATS: Stat[] = [
  { value: 93, suffix: '%', desc: 'Average test pass rate', sub: 'Up from 42% without Healix' },
  { value: 10, suffix: 'x', desc: 'Faster test generation', sub: 'Vs. writing tests manually' },
  { value: null, suffix: '', display: 'ZERO', desc: 'Configuration needed', sub: 'Auto-detects everything' },
  { value: 500, suffix: '+', desc: 'Developers using Healix', sub: 'And growing every day' },
];

function CountUp({ target, suffix }: { target: number; suffix: string }) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-50px' });

  useEffect(() => {
    if (!inView) return;
    const duration = 1600;
    const start = performance.now();
    const frame = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.floor(eased * target));
      if (progress < 1) requestAnimationFrame(frame);
      else setCount(target);
    };
    requestAnimationFrame(frame);
  }, [inView, target]);

  return (
    <span ref={ref} className="tabular-nums">
      {count}{suffix}
    </span>
  );
}

export default function StatsBanner() {
  return (
    <section className="relative py-16 border-y-2 border-[#333] bg-[#0a0a0a]">
      {/* Y2K ticker tape decoration */}
      <div className="absolute top-0 left-0 right-0 h-0.5 bg-white" />
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white" />

      <div className="relative max-w-6xl mx-auto px-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-0 divide-y-2 lg:divide-y-0 lg:divide-x-2 divide-[#333]">
          {STATS.map((stat, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ delay: i * 0.08, duration: 0.5 }}
              className="flex flex-col items-center text-center px-6 py-6 lg:py-2"
            >
              <div className="text-4xl lg:text-5xl font-black text-white mb-2 font-mono">
                {stat.display ? (
                  <span>{stat.display}</span>
                ) : stat.value !== null ? (
                  <CountUp target={stat.value} suffix={stat.suffix} />
                ) : null}
              </div>
              <div className="text-white font-bold text-xs uppercase tracking-widest mb-1 font-mono">{stat.desc}</div>
              <div className="text-[#505050] text-xs font-mono">{stat.sub}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
