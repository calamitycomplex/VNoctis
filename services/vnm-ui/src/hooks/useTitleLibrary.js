import { useState, useEffect, useCallback, useRef } from 'react';
import api from './useApi';

/** Initial server-side page size. Kept modest because the real archive is ~1,252 titles. */
const DEFAULT_PAGE_SIZE = 50;

/**
 * Title-centric library data hook.
 *
 * Requests the Title read API (GET /api/v1/library/titles) with server-side
 * search, sort, availability filtering, and pagination. The legacy Game-based
 * useLibrary hook is intentionally left intact for Gallery and other
 * Game-centric surfaces.
 *
 * Game-keyed mutations (hide/favorite/scan) are still done through the existing
 * compatibility endpoints because runtime state lives on Game in this phase.
 */
export default function useTitleLibrary() {
  const [titles, setTitles] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1, pageSize: DEFAULT_PAGE_SIZE, totalItems: 0, totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);

  const [query, setQuery] = useState({
    search: '', sort: 'name', order: 'asc', sourceAvailable: '', page: 1, pageSize: DEFAULT_PAGE_SIZE,
  });

  const requestId = useRef(0);

  const fetchTitles = useCallback(async ({ silent = false } = {}) => {
    const id = ++requestId.current;
    if (!silent) {
      setLoading(true);
      setError(null);
    }

    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    params.set('sort', query.sort);
    params.set('order', query.order);
    if (query.sourceAvailable) params.set('sourceAvailable', query.sourceAvailable);
    params.set('page', String(query.page));
    params.set('pageSize', String(query.pageSize));

    try {
      const data = await api.get(`/library/titles?${params.toString()}`);
      if (id !== requestId.current) return;

      const next = {
        page: data.pagination?.page ?? query.page,
        pageSize: data.pagination?.pageSize ?? query.pageSize,
        totalItems: data.pagination?.totalItems ?? 0,
        totalPages: data.pagination?.totalPages ?? 0,
      };
      setTitles(Array.isArray(data.items) ? data.items : []);
      setPagination(next);
      if (!silent) setError(null);

      // Clamp an out-of-range page (e.g. deep-link or a filter that shrank results).
      if (next.totalPages > 0 && next.page > next.totalPages) {
        setQuery((prev) => ({ ...prev, page: next.totalPages }));
      }
    } catch (err) {
      if (id !== requestId.current) return;
      if (!silent) setError(err.message || 'Failed to fetch library');
    } finally {
      // The latest request always owns the loading flag, so a silent refetch
      // cannot leave a superseded non-silent fetch spinning forever.
      if (id === requestId.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchTitles();
  }, [fetchTitles]);

  const refetch = useCallback((options = {}) => fetchTitles(options), [fetchTitles]);

  // Filter/sort changes reset to page 1; page changes only move the page.
  const setSearchQuery = useCallback((search) => setQuery((prev) => ({ ...prev, search, page: 1 })), []);
  const setSourceAvailableFilter = useCallback(
    (sourceAvailable) => setQuery((prev) => ({ ...prev, sourceAvailable, page: 1 })),
    [],
  );
  const setSortBy = useCallback((sortBy) => {
    const order = sortBy === 'name-desc' ? 'desc' : 'asc';
    setQuery((prev) => ({ ...prev, sort: 'name', order, page: 1 }));
  }, []);
  const setCurrentPage = useCallback((page) => setQuery((prev) => ({ ...prev, page })), []);
  const setPageSize = useCallback((pageSize) => setQuery((prev) => ({ ...prev, pageSize, page: 1 })), []);
  const clearFilters = useCallback(
    () => setQuery((prev) => ({ ...prev, search: '', sourceAvailable: '', page: 1 })),
    [],
  );

  const triggerScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      await api.post('/library/scan');
      await fetchTitles({ silent: true });
    } catch (err) {
      setError(err.message || 'Scan failed');
    } finally {
      setScanning(false);
    }
  }, [scanning, fetchTitles]);

  /** Game-keyed compatibility actions. Callers pass a nested game.id. */
  const hideGame = useCallback(async (gameId, hidden = true) => {
    try {
      await api.patch(`/library/${gameId}`, { hidden });
      await fetchTitles({ silent: true });
    } catch {
      await fetchTitles({ silent: true });
    }
  }, [fetchTitles]);

  const unhideAll = useCallback(async () => {
    try {
      await api.post('/library/unhide-all');
      await fetchTitles({ silent: true });
    } catch {
      await fetchTitles({ silent: true });
    }
  }, [fetchTitles]);

  const favoriteGame = useCallback(async (gameId, favorite = true) => {
    try {
      if (favorite) await api.post(`/favorites/${gameId}`);
      else await api.delete(`/favorites/${gameId}`);
    } catch {
      // fall through to refetch
    }
    await fetchTitles({ silent: true });
  }, [fetchTitles]);

  const sortBy = query.order === 'desc' ? 'name-desc' : 'name-asc';

  return {
    titles,
    pagination,
    loading,
    error,
    refetch,
    scanning,
    triggerScan,
    hideGame,
    unhideAll,
    favoriteGame,

    searchQuery: query.search,
    setSearchQuery,
    sourceAvailableFilter: query.sourceAvailable,
    setSourceAvailableFilter,
    sortBy,
    setSortBy,
    currentPage: pagination.page,
    setCurrentPage,
    pageSize: pagination.pageSize,
    setPageSize,
    clearFilters,
  };
}
