-- Additive migration: the standard (non-R2) migration chain did not create the
-- Game publish columns, while schema.prisma and the current Prisma Client
-- expect them. These columns were previously added at runtime only when
-- VNM_R2_MODE=true, so a fresh non-R2 database failed the initial library scan.
--
-- Definitions exactly match schema.prisma:
--   publishStatus    String   @default("not_published")
--   publishedAt      DateTime?
--   publishedVersion String?
--
-- ALTER TABLE ADD COLUMN preserves every existing Game column and row; the
-- table is not rebuilt or replaced.

ALTER TABLE "Game" ADD COLUMN "publishStatus" TEXT NOT NULL DEFAULT 'not_published';
ALTER TABLE "Game" ADD COLUMN "publishedAt" DATETIME;
ALTER TABLE "Game" ADD COLUMN "publishedVersion" TEXT;
