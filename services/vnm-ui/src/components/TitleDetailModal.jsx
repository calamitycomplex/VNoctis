import { useState, useEffect, useRef } from 'react';
import api from '../hooks/useApi';
import ScreenshotLightbox from './ScreenshotLightbox';
import { generateGradient, formatRating, getBuildStatusBadge } from '../lib/utils';
import {
  archiveItemsOf,
  coverUrlFor,
  detailFactsFor,
  detailTagsFor,
  displayTitleFor,
  isMultiRelease,
  logicalMetadataFor,
  originalTitleFor,
  screenshotUrlsFor,
} from '../lib/titleDisplay';

/**
 * Rich Title detail modal.
 *
 * Title is the identity and owns logical metadata/media. ArchiveItems are
 * physical sources with optional compatibility Games; runtime/build/publish
 * actions stay Game-keyed and always target a specific release (no implicit
 * primary). Used for multi-release and game-less Titles; single-release Titles
 * still open GameDetailModal via the Library.
 */
export default function TitleDetailModal({ title: initialTitle, onClose, onOpenGame, onToggleFavorite, isAdmin = true, r2Mode = false }) {
  const [title, setTitle] = useState(initialTitle);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lightboxIndex, setLightboxIndex] = useState(null);
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
  const originalTitle = originalTitleFor(title);
  const multi = isMultiRelease(title);
  // Title.metadata is authoritative; nested Game is a compatibility fallback.
  const meta = logicalMetadataFor(title);
  const facts = detailFactsFor(title);
  const tags = detailTagsFor(title);
  const screenshots = screenshotUrlsFor(title);
  const gradient = generateGradient(name);
  // Title-owned cover URL when resolvable; never picks a primary Game.
  const coverUrl = coverUrlFor(title);

  const factItems = [];
  if (facts.rating != null) {
    factItems.push(
      <span key="rating" className="inline-flex items-center gap-1 font-semibold text-amber-500 dark:text-amber-400">
        <svg aria-hidden="true" className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
          <path d="M12 2.5l2.9 6.1 6.6.9-4.8 4.6 1.2 6.5L12 17.5 6.1 20.6l1.2-6.5L2.5 9.5l6.6-.9L12 2.5Z" />
        </svg>
        {formatRating(facts.rating)}
      </span>,
    );
  }
  if (facts.year) {
    factItems.push(
      <span key="year" className="text-gray-600 dark:text-gray-300">
        <span className="text-gray-400 dark:text-gray-500">Released </span>{facts.year}
      </span>,
    );
  }
  if (facts.length) factItems.push(<span key="length" className="text-gray-600 dark:text-gray-300">{facts.length}</span>);
  if (facts.developer) {
    factItems.push(
      <span key="developer" className="text-gray-600 dark:text-gray-300 truncate max-w-[16rem]">{facts.developer}</span>,
    );
  }

  return (
    <>
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
        className="relative w-full max-w-4xl modal-max-h overflow-y-auto bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700/50 motion-safe:animate-scale-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="sticky top-2 right-2 z-20 w-9 h-9 -mb-9 flex items-center justify-center rounded-full bg-gray-200/80 dark:bg-gray-800/80 hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-700 dark:text-white text-lg transition-colors ml-auto"
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
            {/* HERO — blurred cover backdrop, 2:3 cover + title/metadata */}
            <div className="relative overflow-hidden rounded-t-xl border-b border-gray-200 dark:border-gray-700/50">
              <div className="absolute inset-0" style={{ background: gradient }} />
              {coverUrl && (
                <img
                  src={coverUrl}
                  alt=""
                  aria-hidden="true"
                  className="absolute inset-0 w-full h-full object-cover scale-110 blur-2xl brightness-[0.35]"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-black/10" />

              <div className="relative grid gap-5 p-6 sm:grid-cols-[170px_1fr] sm:items-start">
                {/* Cover */}
                <div className="mx-auto w-full max-w-[170px] sm:mx-0">
                  <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-gray-900 ring-1 ring-black/30 shadow-lg">
                    {coverUrl ? (
                      <>
                        <img
                          src={coverUrl}
                          alt=""
                          aria-hidden="true"
                          className="absolute inset-0 w-full h-full object-cover scale-110 blur-xl brightness-[0.4]"
                        />
                        <img
                          src={coverUrl}
                          alt={`Cover for ${name}`}
                          className="absolute inset-0 w-full h-full object-contain"
                        />
                      </>
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center" style={{ background: gradient }}>
                        <span className="text-5xl font-bold text-white/30 select-none">
                          {name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Title + metadata */}
                <div className="min-w-0 text-white">
                  <div className="flex flex-wrap items-start gap-2 mb-2">
                    <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
                      title.sourceAvailable === false
                        ? 'bg-amber-400/90 text-amber-950'
                        : 'bg-green-500/90 text-green-950'
                    }`}>
                      {title.sourceAvailable === false ? 'Source unavailable' : 'Available'}
                    </span>
                    {multi && (
                      <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-indigo-500/90 text-white">
                        {items.length} releases
                      </span>
                    )}
                  </div>

                  <h2 className="text-2xl sm:text-3xl font-bold leading-tight drop-shadow">
                    {name}
                  </h2>
                  {originalTitle && (
                    <p className="text-sm text-white/70 mt-1 line-clamp-2" title={originalTitle}>
                      {originalTitle}
                    </p>
                  )}

                  {factItems.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 mt-3 text-sm">
                      {factItems.map((node, i) => (
                        <span
                          key={node.key}
                          className="inline-flex items-center gap-2 px-2 py-0.5 rounded-md bg-black/35 backdrop-blur-sm"
                        >
                          {node}
                        </span>
                      ))}
                    </div>
                  )}

                  {multi && (
                    <p className="text-xs text-white/60 mt-3">
                      Runtime actions are per-release — choose a source below.
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* BODY */}
            <div className="px-6 py-5 space-y-6">
              {meta.synopsis && (
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-2">
                    Synopsis
                  </h3>
                  <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 whitespace-pre-line max-w-prose">
                    {meta.synopsis}
                  </p>
                </section>
              )}

              {tags.length > 0 && (
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-2">
                    Tags
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-0.5 rounded-md text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {screenshots.length > 0 && (
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-2">
                    Screenshots
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {screenshots.map((url, i) => (
                      <button
                        key={`${url}-${i}`}
                        type="button"
                        onClick={() => setLightboxIndex(i)}
                        className="group relative aspect-video overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700/50 hover:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
                        aria-label={`Open screenshot ${i + 1}`}
                      >
                        <img
                          src={url}
                          alt={`Screenshot ${i + 1}`}
                          loading="lazy"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                        />
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Archive Sources / Releases */}
              <section>
                <h3 className="text-xs font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-2">
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
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                              {item.directoryName}
                            </p>
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
                              {!game && (
                                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                                  Archive only
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
                            {isAdmin && item.directoryPath && (
                              <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate mt-1">
                                {item.directoryPath}
                              </p>
                            )}
                          </div>

                          {game && (
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {onToggleFavorite && (
                                <button
                                  type="button"
                                  onClick={() => onToggleFavorite(game.id, !game.favorite)}
                                  className={`w-8 h-8 flex items-center justify-center rounded-full transition-colors ${
                                    game.favorite
                                      ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                                      : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-300 hover:text-red-400'
                                  }`}
                                  title={game.favorite ? 'Remove from favorites' : 'Add to favorites'}
                                  aria-label={game.favorite ? 'Remove release from favorites' : 'Add release to favorites'}
                                >
                                  <svg aria-hidden="true" className="w-4 h-4" fill={game.favorite ? 'currentColor' : 'none'} viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
                                  </svg>
                                </button>
                              )}
                              {onOpenGame && (
                                <button
                                  type="button"
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
              </section>
            </div>
          </>
        )}
      </div>
    </div>

    {lightboxIndex != null && screenshots.length > 0 && (
      <ScreenshotLightbox
        screenshots={screenshots}
        currentIndex={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onNavigate={setLightboxIndex}
      />
    )}
    </>
  );
}
