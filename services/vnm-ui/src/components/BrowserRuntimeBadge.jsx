import { runtimeStateLabel } from '../lib/titleDisplay';

/**
 * Compact badge for a Title's browser-runtime workflow state.
 *
 * This is intentionally independent of archive source availability: a Title can
 * be source-available yet ARCHIVE_ONLY (no browser runtime), or source-unavailable
 * while a runtime workflow is in flight. READY means the admin workflow considers
 * a browser runtime prepared — it does not launch Kasm yet.
 */
const TONE = {
  ARCHIVE_ONLY: 'bg-gray-100 dark:bg-gray-700/60 text-gray-600 dark:text-gray-300',
  REQUESTED: 'bg-blue-500/15 text-blue-600 dark:text-blue-300',
  PREPARING: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  TESTING: 'bg-purple-500/15 text-purple-600 dark:text-purple-300',
  READY: 'bg-green-500/15 text-green-600 dark:text-green-300',
  BROKEN: 'bg-red-500/15 text-red-600 dark:text-red-300',
  UNSUPPORTED: 'bg-gray-500/20 text-gray-500 dark:text-gray-400',
};

export default function BrowserRuntimeBadge({ state, className = '', title }) {
  const label = runtimeStateLabel(state);
  const tone = TONE[state] || TONE.ARCHIVE_ONLY;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${tone} ${className}`}
      title={title}
    >
      {label}
    </span>
  );
}
