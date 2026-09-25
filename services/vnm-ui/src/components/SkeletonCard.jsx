/**
 * Skeleton loading placeholder matching the portrait TitleCard dimensions.
 * Mirrors the poster block, title lines, facts line, and tag chips so the grid
 * does not jump when real cards arrive.
 */
export default function SkeletonCard() {
  return (
    <div className="flex flex-col rounded-lg overflow-hidden shadow-lg dark:shadow-gray-900/50 ring-1 ring-gray-200 dark:ring-gray-700/50">
      {/* Poster area skeleton */}
      <div className="aspect-[2/3] animate-pulse bg-gray-700" />
      {/* Info area skeleton */}
      <div className="flex flex-1 flex-col px-3 py-2 bg-white dark:bg-gray-800 space-y-1.5">
        <div className="h-4 w-4/5 animate-pulse bg-gray-300 dark:bg-gray-700 rounded" />
        <div className="h-3 w-3/5 animate-pulse bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="h-3 w-1/2 animate-pulse bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="flex gap-1 pt-0.5">
          <div className="h-4 w-12 animate-pulse bg-gray-200 dark:bg-gray-700 rounded-full" />
          <div className="h-4 w-10 animate-pulse bg-gray-200 dark:bg-gray-700 rounded-full" />
        </div>
      </div>
    </div>
  );
}
