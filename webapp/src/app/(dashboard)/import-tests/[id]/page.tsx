'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import type { ImportSession, ImportedTestCase, GeneratedGroovyFile } from '@/lib/types/database'

interface ImportDetail {
  import: ImportSession
  test_cases: ImportedTestCase[]
  groovy_files: GeneratedGroovyFile[]
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    processing: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    completed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    failed: 'bg-red-500/10 text-red-400 border-red-500/20',
    generated: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${styles[status] ?? 'bg-white/5 text-white/50 border-white/10'}`}>
      {status}
    </span>
  )
}

export default function ImportDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [data, setData] = useState<ImportDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'test-cases' | 'groovy-files'>('test-cases')
  const [searchQuery, setSearchQuery] = useState('')
  const [generating, setGenerating] = useState(false)
  const [expandedFileId, setExpandedFileId] = useState<string | null>(null)
  const [expandedTcId, setExpandedTcId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/import-tests/${id}`)
      if (res.status === 404) { router.push('/import-tests'); return }
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load')
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load import')
    } finally {
      setLoading(false)
    }
  }, [id, router])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Poll while processing
  useEffect(() => {
    if (!data) return
    if (data.import.status !== 'processing') return
    const timer = setTimeout(() => fetchData(), 3000)
    return () => clearTimeout(timer)
  }, [data, fetchData])

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch(`/api/import-tests/${id}/generate`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Generation failed')
      await fetchData()
      setActiveTab('groovy-files')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  function handleDownload(file: GeneratedGroovyFile) {
    window.open(`/api/import-tests/${id}/groovy-files/${file.id}/download`, '_blank')
  }

  const filteredTestCases = data?.test_cases.filter((tc) => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      tc.tc_id.toLowerCase().includes(q) ||
      (tc.scenario ?? '').toLowerCase().includes(q) ||
      (tc.functional_area ?? '').toLowerCase().includes(q) ||
      (tc.description ?? '').toLowerCase().includes(q)
    )
  }) ?? []

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto flex flex-col gap-6 animate-pulse">
        <div className="h-8 w-64 bg-white/5 rounded" />
        <div className="h-24 w-full bg-white/5 rounded-xl" />
        <div className="h-64 w-full bg-white/5 rounded-xl" />
      </div>
    )
  }

  if (!data) return null

  const imp = data.import
  const canGenerate = imp.status === 'pending' || imp.status === 'failed'
  const isProcessing = imp.status === 'processing'

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-6">
      {/* Back + Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link
            href="/import-tests"
            className="flex items-center gap-1 text-[#505050] hover:text-white text-xs font-mono uppercase tracking-wider transition-colors mb-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Import Tests
          </Link>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-white font-black text-lg uppercase tracking-widest font-mono">{imp.name}</h1>
            <StatusBadge status={imp.status} />
          </div>
          {imp.description && (
            <p className="text-[#505050] text-xs font-mono mt-1">{imp.description}</p>
          )}
          <p className="text-[#333] text-xs font-mono mt-1">{imp.original_filename}</p>
        </div>

        {/* Generate / Processing indicator */}
        <div className="flex items-center gap-3">
          {isProcessing && (
            <div className="flex items-center gap-2 text-blue-400 text-xs font-mono">
              <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 12a9 9 0 11-6.219-8.56" strokeLinecap="round" />
              </svg>
              Generating Groovy files...
            </div>
          )}
          {canGenerate && (
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="flex items-center gap-2 px-4 py-2 bg-white text-black text-xs font-black font-mono uppercase tracking-widest hover:bg-[#e0e0e0] transition-colors border-2 border-white disabled:opacity-50"
            >
              {generating ? (
                <>
                  <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 12a9 9 0 11-6.219-8.56" strokeLinecap="round" />
                  </svg>
                  Generating...
                </>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  Generate Groovy Files
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-center justify-between px-4 py-3 bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-mono"
          >
            <span>{error}</span>
            <button onClick={() => setError(null)} className="hover:text-red-300 ml-4">✕</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Test Cases', value: imp.test_case_count },
          { label: 'Groovy Files', value: imp.groovy_file_count },
          { label: 'Status', value: imp.status.charAt(0).toUpperCase() + imp.status.slice(1) },
        ].map(({ label, value }) => (
          <div key={label} className="glass-card rounded-xl p-4 text-center">
            <div className="text-white font-black text-xl font-mono">{value}</div>
            <div className="text-[#505050] text-xs font-mono uppercase tracking-wider mt-1">{label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="glass-card rounded-xl overflow-hidden">
        <div className="flex border-b-2 border-[#222]">
          {(['test-cases', 'groovy-files'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-3 text-xs font-black font-mono uppercase tracking-widest transition-colors ${
                activeTab === tab
                  ? 'text-white border-b-2 border-white -mb-[2px]'
                  : 'text-[#505050] hover:text-white'
              }`}
            >
              {tab === 'test-cases'
                ? `Test Cases (${data.test_cases.length})`
                : `Groovy Files (${data.groovy_files.length})`}
            </button>
          ))}
        </div>

        <div className="p-5">
          {activeTab === 'test-cases' && (
            <div className="flex flex-col gap-4">
              {/* Search */}
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by TC ID, scenario, area, description..."
                className="bg-[#0a0a0a] border-2 border-[#333] px-3 py-2 text-white text-xs font-mono focus:border-white outline-none transition-colors placeholder:text-[#333] w-full max-w-md"
              />

              {/* Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="border-b-2 border-[#222]">
                      {['TC ID', 'Active', 'Area', 'Scenario', 'PCC', 'NDC Version', 'Description'].map((h) => (
                        <th key={h} className="text-left px-3 py-2 text-[#505050] uppercase tracking-wider whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTestCases.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-3 py-8 text-center text-[#505050]">
                          {searchQuery ? 'No matching test cases' : 'No test cases'}
                        </td>
                      </tr>
                    ) : (
                      filteredTestCases.flatMap((tc) => {
                        const isExpanded = expandedTcId === tc.id
                        const rawEntries = tc.raw_data ? Object.entries(tc.raw_data as Record<string, unknown>) : []
                        const rows = [
                          <tr
                            key={tc.id}
                            onClick={() => setExpandedTcId(isExpanded ? null : tc.id)}
                            className="border-b border-[#1a1a1a] hover:bg-white/[0.02] transition-colors cursor-pointer select-none"
                          >
                            <td className="px-3 py-2 text-white font-bold whitespace-nowrap">
                              <span className="flex items-center gap-1.5">
                                <svg
                                  width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                                  className={`text-[#505050] transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                                >
                                  <polyline points="9 18 15 12 9 6" />
                                </svg>
                                {tc.tc_id}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <span className={tc.active === 'Y' ? 'text-emerald-400' : 'text-[#505050]'}>
                                {tc.active ?? '—'}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-[#a0a0a0] whitespace-nowrap">{tc.functional_area ?? '—'}</td>
                            <td className="px-3 py-2 text-[#60A5FA] whitespace-nowrap max-w-[200px] truncate" title={tc.scenario ?? ''}>
                              {tc.scenario ?? '—'}
                            </td>
                            <td className="px-3 py-2 text-[#a0a0a0] whitespace-nowrap">{tc.pcc ?? '—'}</td>
                            <td className="px-3 py-2 text-[#a0a0a0] whitespace-nowrap">{tc.ndc_version ?? '—'}</td>
                            <td className="px-3 py-2 text-[#505050] max-w-[240px] truncate" title={tc.description ?? ''}>
                              {tc.description ?? '—'}
                            </td>
                          </tr>,
                        ]
                        if (isExpanded) {
                          rows.push(
                            <tr key={`${tc.id}-detail`} className="border-b border-[#222] bg-[#080808]">
                              <td colSpan={7} className="px-4 py-4">
                                <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs font-mono">
                                  {(
                                    [
                                      ['TC ID', tc.tc_id],
                                      ['Active', tc.active],
                                      ['Functional Area', tc.functional_area],
                                      ['Scenario', tc.scenario],
                                      ['Description', tc.description],
                                      ['Environment', tc.environment_name],
                                      ['NDC Version', tc.ndc_version],
                                      ['PCC', tc.pcc],
                                      ...rawEntries
                                        .filter(([k]) => !['Active','TestCase_ID','Functional_Area','Scenario','Description','Environment_Name','NDC_Version','PCC'].includes(k))
                                        .map(([k, v]) => [k, v]),
                                    ] as [string, unknown][]
                                  ).map(([label, value]) => (
                                    <div key={label} className="flex gap-2 min-w-0">
                                      <span className="text-[#505050] whitespace-nowrap flex-shrink-0 w-36">{label}:</span>
                                      <span className="text-[#a0a0a0] break-all">{value != null ? String(value) : '—'}</span>
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )
                        }
                        return rows
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'groovy-files' && (
            <div className="flex flex-col gap-3">
              {data.groovy_files.length === 0 ? (
                <div className="py-12 flex flex-col items-center gap-4 text-center">
                  <div className="w-14 h-14 border-2 border-[#333] flex items-center justify-center">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#505050" strokeWidth="1.5">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-white font-black text-sm uppercase tracking-widest font-mono">No files generated yet</p>
                    <p className="text-[#505050] text-xs font-mono mt-1">
                      {canGenerate ? 'Click "Generate Groovy Files" to start' : 'Generation in progress...'}
                    </p>
                  </div>
                </div>
              ) : (
                data.groovy_files.map((file) => (
                  <div key={file.id} className="border-2 border-[#222] hover:border-[#333] transition-colors">
                    {/* File header */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="w-8 h-8 bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#34D399" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-bold text-sm font-mono">{file.file_name}</span>
                          <StatusBadge status={file.status} />
                        </div>
                        <span className="text-[#505050] text-xs font-mono">{file.api_type}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => setExpandedFileId(expandedFileId === file.id ? null : file.id)}
                          className="flex items-center gap-1 px-3 py-1.5 text-[#505050] hover:text-white border border-[#333] hover:border-white text-xs font-mono uppercase tracking-wider transition-colors"
                        >
                          {expandedFileId === file.id ? 'Hide' : 'View'}
                        </button>
                        <button
                          onClick={() => handleDownload(file)}
                          className="flex items-center gap-1 px-3 py-1.5 text-white bg-white/10 hover:bg-white/20 border border-white/20 text-xs font-mono uppercase tracking-wider transition-colors"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                          Download
                        </button>
                      </div>
                    </div>

                    {/* Expandable code view */}
                    <AnimatePresence>
                      {expandedFileId === file.id && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden border-t-2 border-[#222]"
                        >
                          <pre className="p-4 text-xs font-mono text-[#a0a0a0] overflow-x-auto max-h-[480px] overflow-y-auto bg-[#050505] leading-relaxed whitespace-pre">
                            {file.groovy_content}
                          </pre>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
