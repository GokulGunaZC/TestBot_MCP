'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import type { ImportSession } from '@/lib/types/database'

function formatDate(iso: string | Date | null) {
  if (!iso) return '—'
  const d = new Date(iso as string)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    processing: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    completed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    failed: 'bg-red-500/10 text-red-400 border-red-500/20',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${styles[status] ?? 'bg-white/5 text-white/50 border-white/10'}`}>
      {status}
    </span>
  )
}

function SkeletonCard() {
  return (
    <div className="glass-card rounded-xl p-5 flex items-center gap-4 animate-pulse">
      <div className="w-10 h-10 rounded-lg bg-white/5 flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-4 w-48 bg-white/5 rounded" />
        <div className="h-3 w-32 bg-white/5 rounded" />
      </div>
    </div>
  )
}

export default function ImportTestsPage() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [imports, setImports] = useState<ImportSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Upload form state
  const [showUploadForm, setShowUploadForm] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [importName, setImportName] = useState('')
  const [importDesc, setImportDesc] = useState('')
  const [uploading, setUploading] = useState(false)

  // Delete confirmation state
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    fetchImports()
  }, [])

  async function fetchImports() {
    setLoading(true)
    try {
      const res = await fetch('/api/import-tests')
      const json = await res.json()
      setImports(json.data ?? [])
    } catch {
      setError('Failed to load imports')
    } finally {
      setLoading(false)
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    setSelectedFile(file)
    if (file && !importName) {
      setImportName(file.name.replace(/\.[^.]+$/, ''))
    }
    setShowUploadForm(true)
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedFile) return

    setUploading(true)
    setError(null)

    const formData = new FormData()
    formData.append('file', selectedFile)
    if (importName.trim()) formData.append('name', importName.trim())
    if (importDesc.trim()) formData.append('description', importDesc.trim())

    try {
      const res = await fetch('/api/import-tests', { method: 'POST', body: formData })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Upload failed')
      router.push(`/import-tests/${json.import_id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
      setUploading(false)
    }
  }

  function cancelUpload() {
    setShowUploadForm(false)
    setSelectedFile(null)
    setImportName('')
    setImportDesc('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      await fetch(`/api/import-tests/${id}`, { method: 'DELETE' })
      setImports((prev) => prev.filter((i) => i.id !== id))
    } catch {
      setError('Failed to delete import')
    } finally {
      setDeletingId(null)
      setConfirmDeleteId(null)
    }
  }

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-white font-black text-xl uppercase tracking-widest font-mono">Import Tests</h1>
          <p className="text-[#505050] text-xs font-mono mt-1 uppercase tracking-wider">
            Upload TCG Excel files to generate Katalon Groovy test classes
          </p>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 px-4 py-2 bg-white text-black text-xs font-black font-mono uppercase tracking-widest hover:bg-[#e0e0e0] transition-colors border-2 border-white"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Upload Excel
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {/* Error banner */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex items-center justify-between px-4 py-3 bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-mono"
          >
            <span>{error}</span>
            <button onClick={() => setError(null)} className="hover:text-red-300 transition-colors ml-4">✕</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Upload form */}
      <AnimatePresence>
        {showUploadForm && (
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="glass-card border-2 border-white/20 p-6"
          >
            <h2 className="text-white font-black text-sm uppercase tracking-widest font-mono mb-4">
              New Import
            </h2>
            <form onSubmit={handleUpload} className="flex flex-col gap-4">
              {/* File info */}
              <div className="flex items-center gap-3 px-4 py-3 bg-[#0a0a0a] border border-[#333]">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="text-[#a0a0a0] text-xs font-mono flex-1 truncate">{selectedFile?.name}</span>
                <span className="text-[#505050] text-xs font-mono">
                  {selectedFile ? `${(selectedFile.size / 1024).toFixed(1)} KB` : ''}
                </span>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[#505050] text-xs font-mono uppercase tracking-wider">Name</label>
                <input
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  placeholder="e.g. FLX-NDC-AA v24.1"
                  className="bg-[#0a0a0a] border-2 border-[#333] px-3 py-2 text-white text-sm font-mono focus:border-white outline-none transition-colors placeholder:text-[#333]"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[#505050] text-xs font-mono uppercase tracking-wider">Description (optional)</label>
                <input
                  value={importDesc}
                  onChange={(e) => setImportDesc(e.target.value)}
                  placeholder="Optional description"
                  className="bg-[#0a0a0a] border-2 border-[#333] px-3 py-2 text-white text-sm font-mono focus:border-white outline-none transition-colors placeholder:text-[#333]"
                />
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  type="submit"
                  disabled={uploading || !selectedFile}
                  className="flex items-center gap-2 px-5 py-2 bg-white text-black text-xs font-black font-mono uppercase tracking-widest hover:bg-[#e0e0e0] transition-colors border-2 border-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {uploading ? (
                    <>
                      <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M21 12a9 9 0 11-6.219-8.56" strokeLinecap="round" />
                      </svg>
                      Uploading...
                    </>
                  ) : (
                    'Parse & Import'
                  )}
                </button>
                <button
                  type="button"
                  onClick={cancelUpload}
                  className="px-5 py-2 text-[#505050] hover:text-white text-xs font-black font-mono uppercase tracking-widest border-2 border-[#333] hover:border-white transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Import list */}
      <div className="flex flex-col gap-3">
        {loading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : imports.length === 0 ? (
          <div className="glass-card rounded-xl p-12 flex flex-col items-center gap-4 text-center">
            <div className="w-16 h-16 border-2 border-[#333] flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#505050" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </div>
            <div>
              <p className="text-white font-black text-sm uppercase tracking-widest font-mono">No imports yet</p>
              <p className="text-[#505050] text-xs font-mono mt-1">Upload an Excel TCG file to get started</p>
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="mt-2 px-5 py-2 bg-white text-black text-xs font-black font-mono uppercase tracking-widest hover:bg-[#e0e0e0] transition-colors border-2 border-white"
            >
              Upload Excel
            </button>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {imports.map((imp, i) => (
              <motion.div
                key={imp.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ delay: i * 0.04 }}
                className="glass-card rounded-xl p-5 flex items-center gap-4 group hover:border-white/20 transition-all border-2 border-transparent"
              >
                <div className="w-10 h-10 bg-blue-500/10 border-2 border-blue-500/20 flex items-center justify-center flex-shrink-0">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                </div>

                <Link href={`/import-tests/${imp.id}`} className="flex-1 min-w-0 group/link">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-bold text-sm font-mono group-hover/link:text-[#60A5FA] transition-colors truncate">
                      {imp.name}
                    </span>
                    <StatusBadge status={imp.status} />
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-[#505050] text-xs font-mono">{imp.test_case_count} test cases</span>
                    {imp.groovy_file_count > 0 && (
                      <span className="text-[#505050] text-xs font-mono">· {imp.groovy_file_count} groovy files</span>
                    )}
                    <span className="text-[#333] text-xs font-mono">· {formatDate(imp.created_at)}</span>
                  </div>
                  {imp.description && (
                    <p className="text-[#505050] text-xs font-mono mt-0.5 truncate">{imp.description}</p>
                  )}
                </Link>

                {/* Delete */}
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  {confirmDeleteId === imp.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[#505050] text-xs font-mono">Delete?</span>
                      <button
                        onClick={() => handleDelete(imp.id)}
                        disabled={deletingId === imp.id}
                        className="text-red-400 hover:text-red-300 text-xs font-mono font-bold transition-colors"
                      >
                        {deletingId === imp.id ? '...' : 'Yes'}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="text-[#505050] hover:text-white text-xs font-mono transition-colors"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(imp.id)}
                      className="p-1.5 text-[#505050] hover:text-red-400 transition-colors"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                        <path d="M10 11v6M14 11v6" />
                        <path d="M9 6V4h6v2" />
                      </svg>
                    </button>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}
