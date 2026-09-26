-- Additive migration: per-app-user Kasm identity for race-free launch targets.
--
-- Kasm expands image `volume_mappings` variables from the Kasm user's mutable
-- custom_attribute_1/2/3 columns, and the manager re-expands them for any kasm
-- still in ASSIGNED/REQUESTED. A single shared Kasm user would therefore be
-- overwritten by a concurrent launch of another app user. Giving every app user
-- a dedicated Kasm user keeps custom_attribute_1 (the app user UUID) stable for
-- the lifetime of that identity; custom_attribute_2 (the runtime UUID) is the
-- only value set per launch and is protected by the one-active-session-per-user
-- BrowserSession policy.
--
-- Both columns are nullable and User rows are untouched; existing users simply
-- gain their Kasm identity lazily on first launch.

ALTER TABLE "User" ADD COLUMN "kasmUsername" TEXT;
ALTER TABLE "User" ADD COLUMN "kasmUserId" TEXT;

CREATE UNIQUE INDEX "User_kasmUsername_key" ON "User"("kasmUsername");
