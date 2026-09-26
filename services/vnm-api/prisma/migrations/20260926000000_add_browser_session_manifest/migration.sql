-- Additive migration: browser-play launch foundation.
--
-- 1. BrowserRuntime gains `manifestId`: an admin-owned key naming a runtime
--    manifest under MANIFEST_ROOT (outside the immutable golden tree). Nullable;
--    existing rows are untouched and no column is dropped.
-- 2. New BrowserSession table records one launch attempt per user/runtime. It has
--    no impact on existing Title/ArchiveItem/Game/User data and is safe on a
--    populated database.
--
-- `activeKey` is a nullable unique guard: set to "<browserRuntimeId>:<userId>"
-- while active and cleared to NULL when the session ends. SQLite considers NULLs
-- distinct, so ended rows never collide while concurrent active duplicates are
-- rejected at the database level.

-- AlterTable
ALTER TABLE "BrowserRuntime" ADD COLUMN "manifestId" TEXT;

-- CreateTable
CREATE TABLE "BrowserSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "browserRuntimeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kasmSessionId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'STARTING',
    "activeKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "BrowserSession_browserRuntimeId_fkey" FOREIGN KEY ("browserRuntimeId") REFERENCES "BrowserRuntime" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BrowserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "BrowserSession_kasmSessionId_key" ON "BrowserSession"("kasmSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserSession_activeKey_key" ON "BrowserSession"("activeKey");

-- CreateIndex
CREATE INDEX "BrowserSession_browserRuntimeId_idx" ON "BrowserSession"("browserRuntimeId");

-- CreateIndex
CREATE INDEX "BrowserSession_userId_idx" ON "BrowserSession"("userId");

-- CreateIndex
CREATE INDEX "BrowserSession_state_idx" ON "BrowserSession"("state");
