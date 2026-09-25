import { useState, useEffect, useMemo, useCallback } from 'react';
import TitleCard from '../components/TitleCard';
import SkeletonCard from '../components/SkeletonCard';
import GameDetailModal from '../components/GameDetailModal';
import TitleDetailModal from '../components/TitleDetailModal';
import SearchAndFilter from '../components/SearchAndFilter';
import SortBar from '../components/SortBar';
import Pagination from '../components/Pagination';
import StarBackground from '../components/StarBackground';
import PublishProgressModal from '../components/PublishProgressModal';
import UnpublishConfirmModal from '../components/UnpublishConfirmModal';
import useTitleLibrary from '../hooks/useTitleLibrary';
import useAuth from '../hooks/useAuth';
import usePublish from '../hooks/usePublish';
import { archiveItemsOf, singleGameFor } from '../lib/titleDisplay';

const TITLE_SORT_OPTIONS = [
  { value: 'name-asc', label: 'Title (A–Z)' },
  { value: 'name-desc', label: 'Title (Z–A)' },
];

const NO_TAGS = new Set();

/**
 * Library page — Title-centric poster wall.
 *
 * Data comes from the Title read API (server-side search/sort/availability and
 * pagination). Title is the catalog identity; Game-keyed compatibility actions
 * (favorite/hide/build/play/publish) still run against a nested Game ID.
 *
 * Single-release Titles open the familiar GameDetailModal directly.
 * Multi-release Titles and Titles without a compatibility Game open
 * TitleDetailModal with an explicit per-release list.
 */
export default function Library({ r2Mode = false }) {
  const { isAdmin } = useAuth();
  const {
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
    searchQuery,
    setSearchQuery,
    sourceAvailableFilter,
    setSourceAvailableFilter,
    sortBy,
    setSortBy,
    currentPage,
    setCurrentPage,
    pageSize,
    clearFilters,
  } = useTitleLibrary();

  const { publishGame, unpublishGame, activeJob, clearJob } = usePublish();
  const [selectedTitle, setSelectedTitle] = useState(null);
  const [selectedGameId, setSelectedGameId] = useState(null);
  const [pendingUnpublishGame, setPendingUnpublishGame] = useState(null);

  // External refresh events (e.g. import from Navbar modal).
  useEffect(() => {
    const handler = () => refetch();
    window.addEventListener('vnm:library-refresh', handler);
    return () => window.removeEventListener('vnm:library-refresh', handler);
  }, [refetch]);

  const hasFilters = Boolean(searchQuery) || Boolean(sourceAvailableFilter);
  const activeFilterCount = (searchQuery ? 1 : 0) + (sourceAvailableFilter ? 1 : 0);
  const hiddenOnPage = useMemo(
    () => titles.filter((title) => singleGameFor(title)?.hidden).length,
    [titles],
  );

  // Resolve the Game behind the active publish job for the progress modal.
  const activeGame = useMemo(() => {
    if (!activeJob?.gameId) return null;
    for (const title of titles) {
      for (const item of archiveItemsOf(title)) {
        if (item.game?.id === activeJob.gameId) return item.game;
      }
    }
    return null;
  }, [titles, activeJob]);

  const handleCardClick = useCallback((title) => {
    const items = archiveItemsOf(title);
    const game = singleGameFor(title);
    if (items.length === 1 && game) setSelectedGameId(game.id);
    else setSelectedTitle(title);
  }, []);

  const handleFavorite = useCallback((title) => {
    const game = singleGameFor(title);
    if (game) favoriteGame(game.id, !game.favorite);
  }, [favoriteGame]);

  const handleHide = useCallback((title) => {
    const game = singleGameFor(title);
    if (game) hideGame(game.id, !game.hidden);
  }, [hideGame]);

  const handleToggleItemFavorite = useCallback((gameId, favorite) => {
    favoriteGame(gameId, favorite);
  }, [favoriteGame]);

  const handleUnhideAll = useCallback(async () => {
    await unhideAll();
  }, [unhideAll]);

  const openGameFromTitle = useCallback((gameId) => {
    setSelectedTitle(null);
    setSelectedGameId(gameId);
  }, []);

  const handlePublish = useCallback(async (game) => {
    try {
      await publishGame(game.id);
    } catch {
      // Error surfaces via the progress modal
    }
  }, [publishGame]);

  const handleUnpublish = useCallback((game) => {
    setPendingUnpublishGame(game);
  }, []);

  const handleUnpublishConfirmed = useCallback(async (gameId) => {
    await unpublishGame(gameId);
    refetch({ silent: true });
  }, [unpublishGame, refetch]);

  const handleUnpublishClose = useCallback(() => setPendingUnpublishGame(null), []);

  const handlePublishDone = useCallback(() => refetch({ silent: true }), [refetch]);

  const handleGameModalClose = useCallback(() => {
    setSelectedGameId(null);
    refetch({ silent: true });
  }, [refetch]);

  const handleTitleModalClose = useCallback(() => {
    setSelectedTitle(null);
    refetch({ silent: true });
  }, [refetch]);

  const handleGameDeleted = useCallback(() => {
    setSelectedGameId(null);
    refetch();
  }, [refetch]);

  // Initial load only — later server fetches (search/sort/page) keep the
  // controls mounted so typing does not lose focus on every request.
  if (loading && titles.length === 0 && pagination.totalItems === 0 && !hasFilters) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
        <div className="text-red-400 mb-4">
          <svg className="w-16 h-16 mx-auto mb-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
          </svg>
          <p className="text-lg font-semibold">Failed to load library</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{error}</p>
        </div>
        <button
          onClick={refetch}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors duration-200"
        >
          Retry
        </button>
      </div>
    );
  }

  // Empty state — no catalog at all
  if (pagination.totalItems === 0 && !hasFilters) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
        <svg className="w-20 h-20 text-gray-300 dark:text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
        </svg>
        <p className="text-lg text-gray-500 dark:text-gray-400 font-medium">No titles found</p>
        <p className="text-sm text-gray-400 dark:text-gray-500 mt-2 max-w-md">
          Add Ren'Py game directories to your <code className="text-gray-700 dark:text-gray-300 bg-gray-200 dark:bg-gray-800 px-1.5 py-0.5 rounded">/games</code> mount and scan.
        </p>
        <button
          onClick={triggerScan}
          disabled={scanning}
          className="mt-4 flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors duration-200"
        >
          {scanning ? (
            <>
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Scanning…
            </>
          ) : (
            'Scan Library'
          )}
        </button>
      </div>
    );
  }

  return (
    <>
    <StarBackground fixed darkOnly />
    <div className="relative z-10 p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] space-y-4">
      {/* Search and availability filter (Title API supported controls only) */}
      <SearchAndFilter
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        sourceAvailableFilter={sourceAvailableFilter}
        onSourceAvailableChange={setSourceAvailableFilter}
        ratingFilter="all"
        onRatingFilterChange={() => {}}
        buildStatusFilter="all"
        onBuildStatusFilterChange={() => {}}
        metadataFilter="all"
        onMetadataFilterChange={() => {}}
        selectedTags={NO_TAGS}
        onToggleTag={() => {}}
        availableTags={[]}
        activeFilterCount={activeFilterCount}
        onClearFilters={clearFilters}
        showRatingFilter={false}
        showBuildFilter={false}
        showMetadataFilter={false}
        showTagFilters={false}
      />

      {/* Sort bar with server-side result count + scan button */}
      <div className="flex items-start justify-between gap-4">
        <SortBar className="flex-1 min-w-0"
          filteredCount={pagination.totalItems}
          totalCount={pagination.totalItems}
          sortBy={sortBy}
          onSortChange={setSortBy}
          currentPage={currentPage}
          pageSize={pageSize}
          showAll={false}
          hiddenCount={0}
          showHidden={false}
          onToggleShowHidden={() => {}}
          sortOptions={TITLE_SORT_OPTIONS}
          entityLabel="title"
        />

        <div className="flex items-center gap-2 flex-shrink-0">
          {isAdmin && hiddenOnPage > 0 && (
            <button
              onClick={handleUnhideAll}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-orange-500 dark:text-orange-400 hover:text-orange-600 dark:hover:text-orange-300 hover:bg-orange-50 dark:hover:bg-orange-900/20 rounded-lg transition-colors duration-200"
              title="Unhide all hidden titles"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
              Unhide All
            </button>
          )}
          {isAdmin && (
            <button
              onClick={triggerScan}
              disabled={scanning}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors duration-200"
              title="Rescan games directory"
            >
              {scanning ? (
                <>
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Scanning…
                </>
              ) : (
                <>
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.992 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
                  </svg>
                  Rescan
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Poster grid */}
      {titles.length > 0 ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {titles.map((title) => (
              <TitleCard
                key={title.id}
                title={title}
                onClick={handleCardClick}
                onHide={handleHide}
                onFavorite={handleFavorite}
                isAdmin={isAdmin}
                r2Mode={r2Mode}
              />
            ))}
          </div>

          <Pagination
            currentPage={currentPage}
            totalPages={pagination.totalPages}
            onPageChange={setCurrentPage}
            showAll={false}
            onToggleShowAll={() => {}}
            filteredCount={pagination.totalItems}
            pageSize={pageSize}
          />
        </>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <svg className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <p className="text-gray-500 dark:text-gray-400 font-medium">
            {pagination.totalItems > 0 ? 'No titles on this page' : 'No titles match your filters'}
          </p>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="mt-3 text-sm text-blue-500 dark:text-blue-400 hover:text-blue-400 dark:hover:text-blue-300 font-medium transition-colors"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}

      {/* Version footer */}
      <footer className="pt-8 pb-4 text-center text-xs text-gray-500 dark:text-gray-600">
        VNoctis Manager v{__APP_VERSION__} &middot; Manage &amp; Play Your Visual Novels
      </footer>
    </div>

    {/* Single-release Title detail — familiar Game detail experience */}
    {selectedGameId && (
      <GameDetailModal
        gameId={selectedGameId}
        onClose={handleGameModalClose}
        onDeleted={handleGameDeleted}
        onHide={(game) => hideGame(game.id, !game.hidden)}
        onFavorite={(game) => favoriteGame(game.id, !game.favorite)}
        onPublish={isAdmin && r2Mode ? handlePublish : undefined}
        onUnpublish={isAdmin && r2Mode ? handleUnpublish : undefined}
        onTagClick={() => setSelectedGameId(null)}
        isAdmin={isAdmin}
        r2Mode={r2Mode}
      />
    )}

    {/* Multi-release / game-less Title detail — explicit release list */}
    {selectedTitle && (
      <TitleDetailModal
        title={selectedTitle}
        onClose={handleTitleModalClose}
        onOpenGame={openGameFromTitle}
        onToggleFavorite={handleToggleItemFavorite}
        isAdmin={isAdmin}
        r2Mode={r2Mode}
      />
    )}

    {/* Publish progress modal */}
    {activeJob && (
      <PublishProgressModal
        jobId={activeJob.jobId}
        gameTitle={activeGame?.vndbTitle || activeGame?.extractedTitle || 'Unknown'}
        coverUrl={activeJob.gameId ? `/api/v1/covers/${activeJob.gameId}` : undefined}
        onClose={clearJob}
        onDone={handlePublishDone}
      />
    )}

    {/* Unpublish confirmation modal */}
    {pendingUnpublishGame && (
      <UnpublishConfirmModal
        game={pendingUnpublishGame}
        onUnpublish={handleUnpublishConfirmed}
        onClose={handleUnpublishClose}
      />
    )}
    </>
  );
}
