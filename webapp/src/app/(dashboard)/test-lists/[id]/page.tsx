'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import type { TestList, TestListItem, TestRun } from '@/lib/types/database';

function formatDate(iso: string | null) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  );
}

interface AvailableTestRun {
  id: string;
  creation_name: string;
  status: string;
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  created_at: string;
}

export default function TestListDetailPage() {
  const params = useParams();
  const router = useRouter();
  const listId = params.id as string;

  const [list, setList] = useState<TestList | null>(null);
  const [items, setItems] = useState<TestListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add test runs modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [availableRuns, setAvailableRuns] = useState<AvailableTestRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set());
  const [addingRuns, setAddingRuns] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Delete state
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);

  const fetchListAndItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listRes, itemsRes] = await Promise.all([
        fetch(`/api/test-lists/${listId}`),
        fetch(`/api/test-lists/${listId}/items`),
      ]);

      if (!listRes.ok) {
        if (listRes.status === 404) {
          router.push('/test-lists');
          return;
        }
        throw new Error('Failed to fetch test list');
      }

      const listJson = await listRes.json();
      const itemsJson = await itemsRes.json();

      setList(listJson.data);
      setItems(itemsJson.data ?? []);
    } catch (err: unknown) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to load test list');
    } finally {
      setLoading(false);
    }
  }, [listId, router]);

  useEffect(() => {
    fetchListAndItems();
  }, [fetchListAndItems]);

  const fetchAvailableRuns = async () => {
    setLoadingRuns(true);
    try {
      // Fetch recent test runs
      const res = await fetch('/api/test-runs?limit=50&order=desc');
      if (!res.ok) throw new Error('Failed to fetch tests');
      const json = await res.json();
      const runs: TestRun[] = json.data ?? [];

      // Filter out runs that are already in this list
      const existingRunIds = new Set(items.map(i => i.test_run_id));
      const available = runs
        .filter(run => !existingRunIds.has(run.id))
        .map(run => ({
          id: run.id,
          creation_name: run.creation_name,
          status: run.status,
          total_tests: run.total_tests ?? 0,
          passed_tests: run.passed_tests ?? 0,
          failed_tests: run.failed_tests ?? 0,
          created_at: run.created_at,
        }));

      setAvailableRuns(available);
    } catch (err) {
      console.error('Failed to fetch available tests:', err);
    } finally {
      setLoadingRuns(false);
    }
  };

  const handleOpenAddModal = () => {
    setShowAddModal(true);
    setSelectedRuns(new Set());
    setSearchQuery('');
    fetchAvailableRuns();
  };

  const handleToggleRun = (runId: string) => {
    setSelectedRuns(prev => {
      const next = new Set(prev);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  };

  const handleAddSelectedRuns = async () => {
    if (selectedRuns.size === 0) return;
    setAddingRuns(true);
    setError(null);

    try {
      const runsToAdd = availableRuns.filter(r => selectedRuns.has(r.id));
      
      for (const run of runsToAdd) {
        const res = await fetch(`/api/test-lists/${listId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            test_name: run.creation_name,
            test_run_id: run.id,
            test_config: { 
              status: run.status, 
              total_tests: run.total_tests,
              passed_tests: run.passed_tests,
              failed_tests: run.failed_tests,
            },
          }),
        });
        if (!res.ok) {
          const json = await res.json();
          throw new Error(json.error ?? 'Failed to add test run');
        }
      }

      setShowAddModal(false);
      fetchListAndItems();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add tests');
    } finally {
      setAddingRuns(false);
    }
  };

  const handleRemoveItem = async (itemId: string) => {
    setDeletingItemId(itemId);
    try {
      const res = await fetch(`/api/test-lists/${listId}/items?item_id=${itemId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error ?? 'Failed to remove test');
      }
      setItems(prev => prev.filter(i => i.id !== itemId));
      if (list) {
        setList({ ...list, test_count: Math.max(0, list.test_count - 1) });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to remove test');
    } finally {
      setDeletingItemId(null);
    }
  };

  const filteredRuns = availableRuns.filter(r =>
    r.creation_name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-white/5 animate-pulse" />
          <div className="h-6 w-48 bg-white/5 rounded animate-pulse" />
        </div>
        <div className="glass-card rounded-2xl p-6">
          <div className="space-y-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 bg-white/5 rounded-xl animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!list) {
    return (
      <div className="max-w-4xl mx-auto flex flex-col items-center justify-center py-20 gap-4">
        <div className="text-[#F0F6FF] font-semibold">Test list not found</div>
        <Link href="/test-lists" className="text-[#60A5FA] hover:underline text-sm">
          Back to Test Lists
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-5">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/test-lists"
            className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-[#4A6280] hover:text-[#F0F6FF] hover:border-white/20 transition-all"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </Link>
          <div>
            <h2 className="text-[#F0F6FF] font-bold text-xl">{list.name}</h2>
            <p className="text-[#4A6280] text-sm mt-0.5">
              {list.test_count} test run{list.test_count !== 1 ? 's' : ''} 
              {/* · Last run: {formatDate(list.last_run_at)} */}
            </p>
          </div>
        </div>
        <button
          onClick={handleOpenAddModal}
          className="btn-gradient flex items-center gap-2 text-black font-semibold px-4 py-2.5 rounded-xl text-sm"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Tests
        </button>
      </motion.div>

      {/* Description */}
      {list.description && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[#8BA4C8] text-sm">
          {list.description}
        </motion.div>
      )}

      {/* Error banner */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="glass-card rounded-xl px-4 py-3 border border-red-500/30 flex items-center justify-between gap-3">
              <span className="text-red-400 text-sm">{error}</span>
              <button onClick={() => setError(null)} className="text-[#4A6280] hover:text-[#F0F6FF] transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Test runs list */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="glass-card rounded-2xl overflow-hidden">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[#4A6280]">
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
                <rect x="9" y="3" width="6" height="4" rx="1" />
                <path d="M9 12h6M9 16h6" />
              </svg>
            </div>
            <div className="text-center">
              <div className="text-[#F0F6FF] font-semibold mb-1">No tests in this list</div>
              <div className="text-[#4A6280] text-sm">Add tests to organize and track your testing</div>
            </div>
            <button onClick={handleOpenAddModal} className="btn-gradient text-black font-semibold px-5 py-2.5 rounded-xl text-sm">
              Add Tests
            </button>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {items.map((item, i) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{
                  opacity: deletingItemId === item.id ? 0.5 : 1,
                  x: 0,
                }}
                transition={{ delay: i * 0.03 }}
                className="flex items-center gap-4 px-5 py-4 hover:bg-white/[0.02] transition-all group"
              >
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-700/20 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" strokeWidth="2">
                    <polyline points="9 11 12 14 22 4" />
                    <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[#F0F6FF] text-sm truncate">{item.test_name}</span>
                    {typeof item.test_config?.status === 'string' && (
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                        item.test_config.status === 'passed'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : item.test_config.status === 'failed'
                          ? 'bg-red-500/10 text-red-400'
                          : 'bg-amber-500/10 text-amber-400'
                      }`}>
                        {item.test_config.status}
                      </span>
                    )}
                  </div>
                  <div className="text-[#4A6280] text-xs mt-0.5 flex items-center gap-2">
                    {typeof item.test_config?.passed_tests === 'number' && typeof item.test_config?.total_tests === 'number' && (
                      <span>{item.test_config.passed_tests}/{item.test_config.total_tests} passed</span>
                    )}
                    <span>Added {formatDateTime(item.created_at)}</span>
                  </div>
                </div>
                <button
                  onClick={() => handleRemoveItem(item.id)}
                  disabled={deletingItemId === item.id}
                  className="w-8 h-8 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 hover:bg-red-500/20 transition-all opacity-0 group-hover:opacity-100 disabled:opacity-50"
                  title="Remove from list"
                >
                  {deletingItemId === item.id ? (
                    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12a9 9 0 11-6.219-8.56" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                    </svg>
                  )}
                </button>
              </motion.div>
            ))}
          </div>
        )}
      </motion.div>

      {/* Add Test Runs Modal */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setShowAddModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="glass-card rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              {/* Modal header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
                <div>
                  <h3 className="text-[#F0F6FF] font-semibold text-lg">Add Tests to List</h3>
                  <p className="text-[#4A6280] text-sm mt-0.5">Select tests to add to this collection</p>
                </div>
                <button
                  onClick={() => setShowAddModal(false)}
                  className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-[#4A6280] hover:text-[#F0F6FF] hover:border-white/20 transition-all"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {/* Search */}
              <div className="px-6 py-3 border-b border-white/5">
                <div className="relative">
                  <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4A6280]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                  </svg>
                  <input
                    type="text"
                    placeholder="Search tests..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="input-glass w-full pl-9 pr-4 py-2.5 text-sm rounded-xl"
                  />
                </div>
              </div>

              {/* Test runs list */}
              <div className="flex-1 overflow-y-auto px-6 py-3">
                {loadingRuns ? (
                  <div className="space-y-3">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="h-16 bg-white/5 rounded-xl animate-pulse" />
                    ))}
                  </div>
                ) : filteredRuns.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-3">
                    <div className="text-[#4A6280] text-sm">
                      {searchQuery ? 'No tests match your search' : 'No available tests found'}
                    </div>
                    {!searchQuery && (
                      <div className="text-[#4A6280] text-xs">
                        Run some tests first to add them to this list
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredRuns.map(run => (
                      <label
                        key={run.id}
                        className={`flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all ${
                          selectedRuns.has(run.id)
                            ? 'bg-blue-500/10 border border-blue-500/30'
                            : 'bg-white/[0.02] border border-transparent hover:bg-white/[0.04]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedRuns.has(run.id)}
                          onChange={() => handleToggleRun(run.id)}
                          className="w-4 h-4 rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500/30"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-[#F0F6FF] text-sm truncate">{run.creation_name}</div>
                          <div className="text-[#4A6280] text-xs mt-0.5 flex items-center gap-2">
                            <span>{run.passed_tests}/{run.total_tests} passed</span>
                            <span>·</span>
                            <span>{formatDate(run.created_at)}</span>
                          </div>
                        </div>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                          run.status === 'passed'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : run.status === 'failed'
                            ? 'bg-red-500/10 text-red-400'
                            : 'bg-amber-500/10 text-amber-400'
                        }`}>
                          {run.status}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Modal footer */}
              <div className="flex items-center justify-between px-6 py-4 border-t border-white/10">
                <div className="text-[#4A6280] text-sm">
                  {selectedRuns.size} test run{selectedRuns.size !== 1 ? 's' : ''} selected
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowAddModal(false)}
                    className="text-[#4A6280] hover:text-[#8BA4C8] font-medium px-4 py-2 rounded-xl text-sm border border-white/10 hover:border-white/20 transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddSelectedRuns}
                    disabled={selectedRuns.size === 0 || addingRuns}
                    className="btn-gradient text-black font-semibold px-5 py-2 rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {addingRuns ? (
                      <>
                        <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 12a9 9 0 11-6.219-8.56" />
                        </svg>
                        <span className="text-black">Adding...</span>
                      </>
                    ) : (
                      <span className="text-black">Add {selectedRuns.size} Run{selectedRuns.size !== 1 ? 's' : ''}</span>
                    )}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
