-- Additive migration: give the logical Title a display identity.
--
-- Nullable so every existing Title row survives untouched, and deliberately
-- not unique: for now one logical Title maps to one ArchiveItem, and later
-- VNDB/manual matching may merge or rename titles.
--
-- ALTER TABLE ADD COLUMN preserves all existing Title columns and rows; the
-- table is not rebuilt or replaced.

ALTER TABLE "Title" ADD COLUMN "name" TEXT;
