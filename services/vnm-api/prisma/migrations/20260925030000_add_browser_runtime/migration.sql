-- Additive migration: browser-runtime workflow state (state/workflow only).
--
-- Two new tables only. No existing table is rebuilt and no column is dropped,
-- so all Title/ArchiveItem/Game/User rows and relationships survive untouched.
-- Video runtimes are Game/build-keyed and remain the legacy compatibility layer;
-- BrowserRuntime is the future browser-play identity and intentionally does not
-- overload Game.
--
-- BrowserRuntime: one row per logical Title. Absence of the row is represented
-- as the ARCHIVE_ONLY state by the API. `archiveItemId` is the release a future
-- curated golden runtime would be built from (SET NULL if the release goes away).
-- WebRequest: one active request per (Title, User), enforced by a unique index.

-- CreateTable
CREATE TABLE "BrowserRuntime" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "titleId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'REQUESTED',
    "archiveItemId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BrowserRuntime_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "Title" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BrowserRuntime_archiveItemId_fkey" FOREIGN KEY ("archiveItemId") REFERENCES "ArchiveItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "titleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebRequest_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "Title" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WebRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "BrowserRuntime_titleId_key" ON "BrowserRuntime"("titleId");

-- CreateIndex
CREATE INDEX "BrowserRuntime_archiveItemId_idx" ON "BrowserRuntime"("archiveItemId");

-- CreateIndex
CREATE UNIQUE INDEX "WebRequest_titleId_userId_key" ON "WebRequest"("titleId", "userId");

-- CreateIndex
CREATE INDEX "WebRequest_titleId_idx" ON "WebRequest"("titleId");

-- CreateIndex
CREATE INDEX "WebRequest_userId_idx" ON "WebRequest"("userId");
