import { useState } from 'react';
import { generateGradient, formatRating, getRatingColor, truncate } from '../lib/utils';
import BrowserRuntimeBadge from './BrowserRuntimeBadge';
import {
  archiveItemsOf,
  browserRuntimeFor,
  cardFactsFor,
  cardTagsFor,
  coverUrlFor,
  displayTitleFor,
  logicalMetadataFor,
  originalTitleFor,
  requestActionFor,
  singleGameFor,
} from '../lib/titleDisplay';

/**
 * Card for one logical Title.
 *
 * Title is the identity (React key and click target). Portrait poster layout
 * with a compact metadata block: canonical title, original title, facts row,
 * tag chips, developer, and runtime/source badges. All data comes from Title
 * metadata with a single-Game compatibility fallback — multi-release Titles
 * never borrow one release's metadata.
 */
export default function TitleCard({
  title, onClick, onHide, onFavorite, isAdmin = true, r2Mode = false,
  isAuthenticated = false, onRequestWebVersion, onWithdrawWebVersion,
}) {
  const [hovered, setHovered] = useState(false);

  const items = archiveItemsOf(title);
  const game = singleGameFor(title);
  const name = displayTitleFor(title);
  const originalTitle = originalTitleFor(title);
  // Title.metadata is authoritative; nested Game is a compatibility fallback.
  const meta = logicalMetadataFor(title);
  const facts = cardFactsFor(title);
  const tags = cardTagsFor(title);
  const gradient = generateGradient(name);

  // Title-owned cover URL when resolvable; falls back to a single legacy Game.
  const baseCoverUrl = coverUrlFor(title);
  const coverUrl = baseCoverUrl
    ? `${baseCoverUrl}?t=${encodeURIComponent(title.updatedAt || '')}`
    : null;

  const isMulti = items.length > 1;
  // Runtime/favorite/hide controls only exist when a specific Game is unambiguous.
  const canAct = !!game && !isMulti;
  const availableSources = items.filter((item) => item.sourceAvailable).length;
  // Browser-runtime workflow is Title-level and independent of source availability.
  const runtime = browserRuntimeFor(title);
  const requestAction = isAuthenticated ? requestActionFor(runtime) : null;
  const runtimeHint = runtime.state === 'READY'
    ? 'Browser runtime prepared — launch itself arrives in a later slice'
    : undefined;

  const handleActivate = () => onClick?.(title);
  const handleKeyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleActivate();
    }
  };

  const factNodes = [];
  if (facts.rating != null) {
    factNodes.push(
      <span key="rating" className="inline-flex items-center gap-1 text-amber-500 dark:text-amber-400 font-semibold">
        <svg aria-hidden="true" className="w-3 h-3 fill-current" viewBox="0 0 24 24">
          <path d="M12 2.5l2.9 6.1 6.6.9-4.8 4.6 1.2 6.5L12 17.5 6.1 20.6l1.2-6.5L2.5 9.5l6.6-.9L12 2.5Z" />
        </svg>
        {formatRating(facts.rating)}
      </span>,
    );
  }
  if (facts.year) factNodes.push(<span key="year">{facts.year}</span>);
  if (facts.length) factNodes.push(<span key="length">{facts.length}</span>);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open details for ${name}`}
      className={`relative flex flex-col rounded-lg overflow-hidden shadow-lg dark:shadow-gray-900/50 cursor-pointer card-hover-scale transition-all duration-200 group focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        game?.hidden
          ? 'opacity-50 ring-2 ring-dashed ring-orange-400/50'
          : 'ring-1 ring-gray-200 dark:ring-gray-700/50'
      }`}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Poster area — 2:3 portrait, blurred fill behind a contained cover */}
      <div className="relative aspect-[2/3] w-full bg-gray-900">
        {coverUrl ? (
          <>
            <img
              src={coverUrl}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 w-full h-full object-cover scale-110 blur-xl brightness-[0.35]"
            />
            <img
              src={coverUrl}
              alt={name}
              loading="lazy"
              className="absolute inset-0 w-full h-full object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]"
            />
          </>
        ) : (
          <div className="absolute inset-0" style={{ background: gradient }}>
            <div className="flex items-center justify-center h-full">
              <span className="text-3xl font-bold text-white/30 select-none">
                {name.charAt(0).toUpperCase()}
              </span>
            </div>
          </div>
        )}

        {/* Rating badge */}
        {facts.rating != null && (
          <div
            className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold text-white shadow ${getRatingColor(facts.rating)}`}
          >
            {formatRating(facts.rating)}
          </div>
        )}

        {/* Favorite heart — single unambiguous Game only */}
        {onFavorite && canAct && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onFavorite(title);
            }}
            className={`absolute top-2 left-2 z-10 w-7 h-7 flex items-center justify-center rounded-full backdrop-blur-sm transition-all duration-200 ${
              game.favorite
                ? 'bg-red-500/30 text-red-400 hover:bg-red-500/50 hover:text-red-300 opacity-100'
                : 'bg-black/40 text-white/50 hover:bg-black/60 hover:text-red-400 opacity-70 group-hover:opacity-100'
            }`}
            title={game.favorite ? 'Remove from favorites' : 'Add to favorites'}
            aria-label={game.favorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <svg aria-hidden="true" className="w-4 h-4" fill={game.favorite ? 'currentColor' : 'none'} viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
            </svg>
          </button>
        )}

        {/* Status overlays — Title-level availability plus single-release runtime state */}
        <div className={`absolute top-2 ${onFavorite && canAct ? 'left-11' : 'left-2'} flex flex-col gap-1`}>
          {title.sourceAvailable === false && (
            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-900 shadow">
              Source unavailable
            </span>
          )}
          {isMulti && (
            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-indigo-600 text-white shadow">
              {items.length} releases
            </span>
          )}
          {game?.metadataSource === 'unmatched' && (
            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-orange-600 text-white shadow">
              Unmatched
            </span>
          )}
          {game?.buildStatus === 'building' && (
            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-blue-500 text-white shadow animate-pulse">
              Building…
            </span>
          )}
          {game?.buildStatus === 'queued' && (
            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-yellow-500 text-gray-900 shadow">
              Queued
            </span>
          )}
          {game?.buildStatus === 'built' && (
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-600/80 text-white shadow">
              <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </span>
          )}
          {game?.buildStatus === 'failed' && (
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-red-600/80 text-white shadow">
              <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </span>
          )}
        </div>

        {/* Hide/Unhide — single unambiguous Game only, admin only */}
        {isAdmin && onHide && canAct && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onHide(title);
            }}
            className={`absolute bottom-2 right-2 w-7 h-7 flex items-center justify-center rounded-full backdrop-blur-sm transition-all duration-200 ${
              game.hidden
                ? 'bg-orange-500/30 text-orange-300 hover:bg-orange-500/50 hover:text-orange-200 opacity-100'
                : 'bg-black/40 text-white/70 hover:bg-black/60 hover:text-white opacity-0 group-hover:opacity-100'
            }`}
            title={game.hidden ? 'Unhide this title' : 'Hide this title'}
            aria-label={game.hidden ? 'Unhide this title' : 'Hide this title'}
          >
            {game.hidden ? (
              <svg aria-hidden="true" className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
            ) : (
              <svg aria-hidden="true" className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
              </svg>
            )}
          </button>
        )}
      </div>

      {/* Compact info block */}
      <div className="flex flex-1 flex-col px-3 py-2 bg-white dark:bg-gray-800 min-w-0">
        {game?.hidden && (
          <span className="float-right ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-orange-500/20 text-orange-400">
            Hidden
          </span>
        )}
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white leading-tight line-clamp-2">
          {name}
        </h3>
        {originalTitle && (
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-tight line-clamp-1" title={originalTitle}>
            {originalTitle}
          </p>
        )}

        {factNodes.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            {factNodes.map((node, i) => (
              <span key={node.key} className="inline-flex items-center gap-2">
                {i > 0 && <span className="text-gray-300 dark:text-gray-600">·</span>}
                {node}
              </span>
            ))}
          </div>
        )}

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {tags.map((tag) => (
              <span
                key={tag}
                className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-gray-700/60 text-gray-600 dark:text-gray-300 truncate max-w-full"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {meta.developer && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">{meta.developer}</p>
        )}

        {isMulti && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
            {availableSources} of {items.length} sources available
          </p>
        )}
        {r2Mode && game?.buildStatus === 'built' && (
          <span className={`inline-block mt-1 text-[10px] font-medium ${
            game.publishStatus === 'published' ? 'text-green-500' : 'text-gray-400 dark:text-gray-500'
          }`}>
            {game.publishStatus === 'published' ? '● R2 Published' : '○ Not Published'}
          </span>
        )}

        {/* Browser-runtime workflow — distinct from source availability */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <BrowserRuntimeBadge state={runtime.state} title={runtimeHint} />
          {requestAction === 'request' && onRequestWebVersion && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRequestWebVersion(title); }}
              className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
              aria-label={`Request a web version of ${name}`}
            >
              Request Web Version
            </button>
          )}
          {requestAction === 'withdraw' && onWithdrawWebVersion && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onWithdrawWebVersion(title); }}
              className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-blue-600 dark:text-blue-300 hover:bg-blue-500/10 transition-colors"
              aria-label={`Withdraw web version request for ${name}`}
            >
              Withdraw
            </button>
          )}
        </div>
      </div>

      {/* Hover: synopsis + explicit details affordance (bottom gradient, top badges stay visible) */}
      {hovered && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 rounded-b-lg bg-gradient-to-t from-black/95 via-black/80 to-transparent p-4 pt-10">
          {meta.synopsis && (
            <p className="text-xs text-gray-200 leading-relaxed line-clamp-3">
              {truncate(meta.synopsis, 180)}
            </p>
          )}
          <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-300">
            View details
            <svg aria-hidden="true" className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12l-7.5 7.5M3 12h18" />
            </svg>
          </span>
        </div>
      )}
    </div>
  );
}
