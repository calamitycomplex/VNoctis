-- Additive migration: preserve all existing Game columns, including R2-only
-- columns managed by application startup, and retain UserFavorite relationships.
-- UUIDs and updatedAt values for new records are supplied by Prisma Client.

-- CreateTable
CREATE TABLE "Title" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ArchiveItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "titleId" TEXT NOT NULL,
    "directoryPath" TEXT NOT NULL,
    "directoryName" TEXT NOT NULL,
    "sourceAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArchiveItem_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "Title" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- AlterTable (no table rebuild or foreign-key disabling)
ALTER TABLE "Game" ADD COLUMN "sourceAvailable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Game" ADD COLUMN "archiveItemId" TEXT
    CONSTRAINT "Game_archiveItemId_fkey"
    REFERENCES "ArchiveItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScanJob" ADD COLUMN "gamesUnavailable" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "Game_archiveItemId_key" ON "Game"("archiveItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ArchiveItem_directoryPath_key" ON "ArchiveItem"("directoryPath");

-- CreateIndex
CREATE INDEX "ArchiveItem_titleId_idx" ON "ArchiveItem"("titleId");
