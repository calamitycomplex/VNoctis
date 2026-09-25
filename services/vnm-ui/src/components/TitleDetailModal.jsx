import { useState, useEffect, useRef } from 'react';
import api from '../hooks/useApi';
import { generateGradient, getBuildStatusBadge } from '../lib/utils';
import { archiveItemsOf, coverUrlFor, displayTitleFor, isMultiRelease, logicalMetadataFor } from '../lib/titleDisplay';

/**
 * Title detail modal for Titles that should not open a single Game detail
 * directly: multi-release Titles and Titles without a compatibility Game.
 *
 * Lists every ArchiveItem ("Archive Sources") with its own availability and
 * Game runtime state, and delegates per-release runtime actions to the existing
 * GameDetailModal via onOpenGame(gameId). No implicit primary is chosen.
 */
export default function TitleDetailModal({ title: initialTitle, onClose, onOpenGame, onToggleFavorite, isAdmin = true, r2Mode = false }) {
  const [title, setTitle] = useState(initialTitle);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const modalRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get(`/library/titles/${initialTitle.id}`)
      .then((data) => { if (!cancelled) setTitle(data); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Failed to load title details'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [initialTitle.id]);

  // Scroll lock + Escape/focus handling, matching GameDetailModal.
  useEffect(() => {
    const scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.overflow = '';
      window.scrollTo(0, scrollY);
    };
  }, []);

  useEffect(() => {
    modalRef.current?.focus();
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const items = archiveItemsOf(title);
  const name = displayTitleFor(title);
  const multi = isMultiRelease(title);
  // Title.metadata is authoritative; nested Game is a compatibility fallback.
  const meta = logicalMetadataFor(title);
  const gradient = generateGradient(name);
  // Title-owned cover URL when resolvable; never picks a primary Game.
  const coverUrl = coverUrlFor(title);

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start sm:items-center justify-center bg-black/60 dark:bg-black/70 backdrop-blur-sm modal-safe-pad motion-safe:animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={loading ? 'Loading title details' : `Details for ${name}`}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="relative w-full max-w-3xl modal-max-h overflow-y-auto bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700/50 motion-safe:animate-scale-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="sticky top-2 right-2 z-10 w-9 h-9 -mb-9 flex items-center justify-center rounded-full bg-gray-200/80 dark:bg-gray-800/80 hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-700 dark:text-white text-lg transition-colors ml-auto"
          onClick={onClose}
          aria-label="Close modal"
        >
          ✕
        </button>

        {loading && (
          <div className="flex items-center justify-center h-64">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col items-center justify-center h-64 text-center px-6">
            <p className="text-red-400 font-semibold mb-2">Failed to load</p>
            <p className="text-gray-400 text-sm">{error}</p>
          </div>
        )}

        {title && !loading && !error && (
          <>
            <div className="relative w-full h-40 sm:h-48 overflow-hidden rounded-t-xl">
              <div className="absolute inset-0" style={{ background: gradient }} />
              {coverUrl && (
                <img
                  src={coverUrl}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-white dark:from-gray-900 via-white/40 dark:via-gray-900/40 to-transparent" />
            </div>

            <div className="px-6 pb-6 -mt-10 relative">
              <div className="flex items-start gap-3 mb-4">
                <div className="flex-1 min-w-0">
                  <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white leading-tight">
                    {name}
                  </h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {multi ? `${items.length} archive sources` : '1 archive source'}
                  </p>
                  {meta.developer && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 truncate">{meta.developer}</p>
                  )}
                </div>
                <span className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-sm font-semibold ${
                  title.sourceAvailable === false
                    ? 'bg-amber-100 text-amber-900'
                    : 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                }`}>
                  {title.sourceAvailable === false ? 'Source unavailable' : 'Available'}
                </span>
              </div>

              {multi && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                  This title has multiple releases. Runtime actions are per-release — choose a source below.
                </p>
              )}

              {meta.synopsis && (
                <p className="text-sm text-gray-600 dark:text-gray-300 mb-4 line-clamp-4">{meta.synopsis}</p>
              )}

              <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                Archive Sources
              </h3>

              <ul className="space-y-2">
                {items.map((item) => {
                  const game = item.game;
                  const buildBadge = game ? getBuildStatusBadge(game.buildStatus) : null;
                  return (
                    <li
                      key={item.id}
                      className="rounded-lg border border-gray-200 dark:border-gray-700/50 p-3 bg-gray-50 dark:bg-gray-800/50"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                            {item.directoryName}
                          </p>
                          {item.directoryPath && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{item.directoryPath}</p>
                          )}
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                              item.sourceAvailable
                                ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                                : 'bg-amber-100 text-amber-900'
                            }`}>
                              {item.sourceAvailable ? 'Source available' : 'Source unavailable'}
                            </span>
                            {buildBadge && (
                              <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${buildBadge.colorClass}`}>
                                {buildBadge.label}
                              </span>
                            )}
                            {game?.hidden && (
                              <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-orange-500/20 text-orange-400">
                                Hidden
                              </span>
                            )}
                            {r2Mode && game && (
                              <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                                game.publishStatus === 'published' ? 'text-green-600' : 'text-gray-500 dark:text-gray-400'
                              }`}>
                                {game.publishStatus === 'published' ? '● R2 Published' : '○ Not Published'}
                              </span>
                            )}
                          </div>
                        </div>

                        {game && (
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {onToggleFavorite && (
                              <button
                                onClick={() => onToggleFavorite(game.id, !game.favorite)}
                                className={`w-8 h-8 flex items-center justify-center rounded-full transition-colors ${
                                  game.favorite
                                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                                    : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-300 hover:text-red-400'
                                }`}
                                title={game.favorite ? 'Remove from favorites' : 'Add to favorites'}
                                aria-label={game.favorite ? 'Remove release from favorites' : 'Add release to favorites'}
                              >
                                <svg className="w-4 h-4" fill={game.favorite ? 'currentColor' : 'none'} viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
                                </svg>
                              </button>
                            )}
                            {onOpenGame && (
                              <button
                                onClick={() => onOpenGame(game.id)}
                                className="px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
                              >
                                Manage release
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {!game && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                          No compatibility Game record — runtime actions unavailable for this source.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>

              {isAdmin && (
                <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-4">
                  Metadata, build, and publish actions run against a specific release's Game record.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
