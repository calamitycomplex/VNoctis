-- Additive migration: give the logical Title authoritative logical-metadata
-- storage, mirroring the existing Game column types/defaults exactly.
--
-- Every statement is ALTER TABLE ADD COLUMN on the existing Title table, so no
-- table is rebuilt, no column is dropped, and all Title/ArchiveItem/Game rows
-- and relationships survive untouched. Game retains its metadata fields for the
-- compatibility period; this migration only adds nullable/empty defaults.

ALTER TABLE "Title" ADD COLUMN "vndbId" TEXT;
ALTER TABLE "Title" ADD COLUMN "vndbTitle" TEXT;
ALTER TABLE "Title" ADD COLUMN "vndbTitleOriginal" TEXT;
ALTER TABLE "Title" ADD COLUMN "synopsis" TEXT;
ALTER TABLE "Title" ADD COLUMN "developer" TEXT;
ALTER TABLE "Title" ADD COLUMN "releaseDate" DATETIME;
ALTER TABLE "Title" ADD COLUMN "lengthMinutes" INTEGER;
ALTER TABLE "Title" ADD COLUMN "vndbRating" REAL;
ALTER TABLE "Title" ADD COLUMN "coverPath" TEXT;
ALTER TABLE "Title" ADD COLUMN "tags" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Title" ADD COLUMN "screenshots" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Title" ADD COLUMN "metadataSource" TEXT NOT NULL DEFAULT 'unmatched';
ALTER TABLE "Title" ADD COLUMN "metadataFetchedAt" DATETIME;
