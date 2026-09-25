import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractArchiveToStaging,
  getSingleTopLevelFolderFromMembers,
  inspectArchiveMembers,
  isSafeMemberName,
  parse7zMemberList,
  parseTarMemberList,
  parseZipMemberList,
  resolveImportStagingRoot,
  validateArchiveMembers,
} from './importStaging.js';
import { installFakeArchiveTools } from '../../test/helpers/fakeArchiveTools.js';

const silentLogger = { info() {}, warn() {} };

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const zipListing = (entries) =>
  ['Archive:  /tmp/sample.zip', ...entries, ''].join('\n');

const zipEntry = (name, date = '24-Jan-01 12:00') =>
  `-rw-r--r--  3.0 unx  10  bx defN ${date} ${name}`;

// zipinfo flags a symlink with `lrwxrwxrwx` but does not print `-> target`.
const zipSymlinkEntry = (name, date = '24-Jan-01 12:00') =>
  `lrwxrwxrwx  3.0 unx   0  bx defN ${date} ${name}`;

async function seedSymlinkTarget(dir, memberName, content) {
  const p = join(dir, memberName);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vnoctis-import-'));
  const gamesPath = join(root, 'games');
  const stagingRoot = join(root, 'web-builds', 'imports');
  const contentsDir = join(root, 'contents');
  await mkdir(gamesPath, { recursive: true });
  await mkdir(contentsDir, { recursive: true });

  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, gamesPath, stagingRoot, contentsDir };
}

test('member name validation rejects traversal and absolute paths', () => {
  assert.equal(isSafeMemberName('MyGame/game/script.rpy'), true);
  assert.equal(isSafeMemberName('../evil.txt'), false);
  assert.equal(isSafeMemberName('MyGame/../../evil.txt'), false);
  assert.equal(isSafeMemberName('/etc/passwd'), false);
  assert.equal(isSafeMemberName('C:\\Windows\\evil.txt'), false);

  assert.throws(
    () => validateArchiveMembers([{ name: '../evil.txt' }]),
    /Unsafe archive path/
  );
  assert.throws(
    () => validateArchiveMembers([{ name: '/etc/passwd' }]),
    /Unsafe archive path/
  );
});

test('link targets that escape staging are rejected, contained links pass', () => {
  assert.throws(
    () =>
      validateArchiveMembers([
        { name: 'MyGame/game/link', linkKind: 'symlink', linkTarget: '../../../outside' },
      ]),
    /Unsafe symlink/
  );
  assert.throws(
    () =>
      validateArchiveMembers([
        { name: 'MyGame/game/abs', linkKind: 'symlink', linkTarget: '/etc/passwd' },
      ]),
    /Unsafe symlink/
  );
  assert.throws(
    () =>
      validateArchiveMembers([
        { name: 'MyGame/game/hard', linkKind: 'hardlink', linkTarget: '../outside' },
      ]),
    /Unsafe hardlink/
  );

  validateArchiveMembers([
    { name: 'MyGame/game/ok', linkKind: 'symlink', linkTarget: 'script.rpy' },
  ]);
});

test('parsers classify symlinks and hardlinks', () => {
  const tar = parseTarMemberList(
    [
      '-rw-r--r-- user/group 10 2024-01-01 12:00 MyGame/game/script.rpy',
      'lrwxrwxrwx user/group  0 2024-01-01 12:00 MyGame/game/link -> script.rpy',
      'hrw-r--r-- user/group  0 2024-01-01 12:00 MyGame/game/hard link to MyGame/game/script.rpy',
    ].join('\n')
  );
  assert.deepEqual(tar[0], { name: 'MyGame/game/script.rpy', linkKind: null, linkTarget: null });
  assert.equal(tar[1].linkKind, 'symlink');
  assert.equal(tar[1].linkTarget, 'script.rpy');
  assert.equal(tar[2].linkKind, 'hardlink');

  const zip = parseZipMemberList(
    zipListing([
      zipEntry('MyGame/'),
      zipEntry('MyGame/game/script.rpy'),
      'lrwxrwxrwx  3.0 unx   0  bx defN 24-Jan-01 12:00 MyGame/game/link -> script.rpy',
    ])
  );
  assert.equal(zip.length, 3);
  assert.equal(zip[2].linkKind, 'symlink');
  assert.equal(zip[2].linkTarget, 'script.rpy');

  const sevenZip = parse7zMemberList(
    [
      'Path = /tmp/sample.rar',
      '',
      'Path = MyGame',
      'Attributes = D',
      '',
      'Path = MyGame/game/link',
      'Symbolic Link = ../outside',
      '',
    ].join('\n')
  );
  assert.equal(sevenZip[1].name, 'MyGame');
  assert.equal(sevenZip[2].linkKind, 'symlink');
  assert.equal(sevenZip[2].linkTarget, '../outside');
});

test('parseZipMemberList flags a symlink from Unix mode even without a printed target', () => {
  const members = parseZipMemberList(
    zipListing([
      zipEntry('MyGame/'),
      zipEntry('MyGame/game/script.rpy'),
      zipSymlinkEntry('MyGame/game/link'),
    ])
  );

  assert.equal(members.length, 3);
  assert.equal(members[2].name, 'MyGame/game/link');
  assert.equal(members[2].linkKind, 'symlink');
  assert.equal(members[2].linkTarget, null);
});

test('inspectArchiveMembers reads ZIP symlink targets without extracting', async (t) => {
  const { root, contentsDir } = await fixture(t);
  const targetsDir = join(root, 'symlink-targets');
  await seedSymlinkTarget(targetsDir, 'MyGame/game/link', '../images');

  const listing = zipListing([
    zipEntry('MyGame/game/script.rpy'),
    zipSymlinkEntry('MyGame/game/link'),
  ]);
  const tools = await installFakeArchiveTools({ listing, contentsDir, symlinkTargetsDir: targetsDir });
  t.after(() => tools.restore());

  const archivePath = join(root, 'sample.zip');
  await writeFile(archivePath, 'ARCHIVE');

  const members = await inspectArchiveMembers({ archivePath, type: 'zip' });
  assert.equal(members[1].linkKind, 'symlink');
  assert.equal(members[1].linkTarget, '../images');
});

test('escaping relative ZIP symlink target is rejected before extraction', async (t) => {
  const { root, gamesPath, stagingRoot } = await fixture(t);
  const targetsDir = join(root, 'symlink-targets');
  await seedSymlinkTarget(targetsDir, 'MyGame/game/link', '../../../outside');

  const listing = zipListing([
    zipEntry('MyGame/'),
    zipEntry('MyGame/game/script.rpy'),
    zipSymlinkEntry('MyGame/game/link'),
  ]);
  // contentsDir points at a non-existent directory: if the extractor were
  // invoked it would fail with a command error, not an UNSAFE_ARCHIVE code.
  const tools = await installFakeArchiveTools({
    listing,
    contentsDir: join(root, 'does-not-exist'),
    symlinkTargetsDir: targetsDir,
  });
  t.after(() => tools.restore());

  const archivePath = join(root, 'sample.zip');
  await writeFile(archivePath, 'ARCHIVE');

  let error;
  try {
    await extractArchiveToStaging({
      archivePath,
      originalName: 'sample.zip',
      type: 'zip',
      stagingRoot,
      logger: silentLogger,
    });
  } catch (err) {
    error = err;
  }

  assert.ok(error, 'expected rejection');
  assert.equal(error.code, 'UNSAFE_ARCHIVE');
  assert.equal(error.statusCode, 400);
  assert.match(error.message, /Unsafe symlink/);
  assert.deepEqual(await readdir(gamesPath), []);
  assert.deepEqual(await readdir(stagingRoot).catch(() => []), []);
});

test('absolute ZIP symlink target is read pre-extraction and rejected', async (t) => {
  const { root, gamesPath, stagingRoot } = await fixture(t);
  const targetsDir = join(root, 'symlink-targets');
  await seedSymlinkTarget(targetsDir, 'MyGame/game/link', '/etc/passwd');

  const listing = zipListing([
    zipEntry('MyGame/'),
    zipEntry('MyGame/game/script.rpy'),
    zipSymlinkEntry('MyGame/game/link'),
  ]);
  const tools = await installFakeArchiveTools({
    listing,
    contentsDir: join(root, 'does-not-exist'),
    symlinkTargetsDir: targetsDir,
  });
  t.after(() => tools.restore());

  const archivePath = join(root, 'sample.zip');
  await writeFile(archivePath, 'ARCHIVE');

  await assert.rejects(
    () =>
      extractArchiveToStaging({
        archivePath,
        originalName: 'sample.zip',
        type: 'zip',
        stagingRoot,
        logger: silentLogger,
      }),
    (err) => {
      assert.equal(err.code, 'UNSAFE_ARCHIVE');
      assert.equal(err.statusCode, 400);
      return true;
    }
  );

  assert.deepEqual(await readdir(gamesPath), []);
  assert.deepEqual(await readdir(stagingRoot).catch(() => []), []);
});

test('contained relative ZIP symlink target passes preflight and import succeeds', async (t) => {
  const { root, gamesPath, stagingRoot, contentsDir } = await fixture(t);
  await mkdir(join(contentsDir, 'MyGame', 'game'), { recursive: true });
  await writeFile(join(contentsDir, 'MyGame', 'game', 'script.rpy'), 'label start:');

  const targetsDir = join(root, 'symlink-targets');
  await seedSymlinkTarget(targetsDir, 'MyGame/game/link', 'script.rpy');

  const listing = zipListing([
    zipEntry('MyGame/'),
    zipEntry('MyGame/game/script.rpy'),
    zipSymlinkEntry('MyGame/game/link'),
  ]);
  const tools = await installFakeArchiveTools({ listing, contentsDir, symlinkTargetsDir: targetsDir });
  t.after(() => tools.restore());

  const archivePath = join(root, 'sample.zip');
  await writeFile(archivePath, 'ARCHIVE');

  const result = await extractArchiveToStaging({
    archivePath,
    originalName: 'sample.zip',
    type: 'zip',
    stagingRoot,
    logger: silentLogger,
  });

  assert.equal(result.folderName, 'MyGame');
  assert.equal(await exists(join(result.path, 'game', 'script.rpy')), true);
  assert.deepEqual(await readdir(stagingRoot), [result.stagingId]);
  assert.deepEqual(await readdir(gamesPath), []);
});

test('NUL-containing ZIP symlink target fails safely before extraction', async (t) => {
  const { root, gamesPath, stagingRoot } = await fixture(t);
  const targetsDir = join(root, 'symlink-targets');
  await seedSymlinkTarget(targetsDir, 'MyGame/game/link', Buffer.from([0x2e, 0x2e, 0x00, 0x78]));

  const listing = zipListing([
    zipEntry('MyGame/'),
    zipEntry('MyGame/game/script.rpy'),
    zipSymlinkEntry('MyGame/game/link'),
  ]);
  const tools = await installFakeArchiveTools({
    listing,
    contentsDir: join(root, 'does-not-exist'),
    symlinkTargetsDir: targetsDir,
  });
  t.after(() => tools.restore());

  const archivePath = join(root, 'sample.zip');
  await writeFile(archivePath, 'ARCHIVE');

  await assert.rejects(
    () =>
      extractArchiveToStaging({
        archivePath,
        originalName: 'sample.zip',
        type: 'zip',
        stagingRoot,
        logger: silentLogger,
      }),
    (err) => {
      assert.equal(err.code, 'ARCHIVE_INSPECTION_FAILED');
      return true;
    }
  );

  assert.deepEqual(await readdir(gamesPath), []);
  assert.deepEqual(await readdir(stagingRoot).catch(() => []), []);
});

test('oversized ZIP symlink target fails safely before extraction', async (t) => {
  const { root, gamesPath, stagingRoot } = await fixture(t);
  const targetsDir = join(root, 'symlink-targets');
  await seedSymlinkTarget(targetsDir, 'MyGame/game/link', 'a'.repeat(5000));

  const listing = zipListing([
    zipEntry('MyGame/'),
    zipEntry('MyGame/game/script.rpy'),
    zipSymlinkEntry('MyGame/game/link'),
  ]);
  const tools = await installFakeArchiveTools({
    listing,
    contentsDir: join(root, 'does-not-exist'),
    symlinkTargetsDir: targetsDir,
  });
  t.after(() => tools.restore());

  const archivePath = join(root, 'sample.zip');
  await writeFile(archivePath, 'ARCHIVE');

  await assert.rejects(
    () =>
      extractArchiveToStaging({
        archivePath,
        originalName: 'sample.zip',
        type: 'zip',
        stagingRoot,
        logger: silentLogger,
      }),
    (err) => {
      assert.equal(err.code, 'ARCHIVE_INSPECTION_FAILED');
      return true;
    }
  );

  assert.deepEqual(await readdir(gamesPath), []);
  assert.deepEqual(await readdir(stagingRoot).catch(() => []), []);
});

test('absolute-path ZIP member names are still rejected before extraction', async (t) => {
  const { root, gamesPath, stagingRoot } = await fixture(t);
  const listing = zipListing([zipEntry('/abs.txt'), zipEntry('ok.txt')]);
  const tools = await installFakeArchiveTools({
    listing,
    contentsDir: join(root, 'does-not-exist'),
  });
  t.after(() => tools.restore());

  const archivePath = join(root, 'sample.zip');
  await writeFile(archivePath, 'ARCHIVE');

  await assert.rejects(
    () =>
      extractArchiveToStaging({
        archivePath,
        originalName: 'sample.zip',
        type: 'zip',
        stagingRoot,
        logger: silentLogger,
      }),
    (err) => {
      assert.equal(err.code, 'UNSAFE_ARCHIVE');
      assert.equal(err.statusCode, 400);
      return true;
    }
  );

  assert.deepEqual(await readdir(gamesPath), []);
  assert.deepEqual(await readdir(stagingRoot).catch(() => []), []);
});

test('getSingleTopLevelFolderFromMembers detects a single top folder', () => {
  const members = parseZipMemberList(
    zipListing([zipEntry('MyGame/'), zipEntry('MyGame/game/script.rpy')])
  );
  assert.equal(getSingleTopLevelFolderFromMembers(members), 'MyGame');

  const multi = parseZipMemberList(
    zipListing([zipEntry('a.txt'), zipEntry('b.txt')])
  );
  assert.equal(getSingleTopLevelFolderFromMembers(multi), null);
});

test('extraction writes to staging only, never beneath GAMES_PATH', async (t) => {
  const { root, gamesPath, stagingRoot, contentsDir } = await fixture(t);
  await mkdir(join(contentsDir, 'MyGame', 'game'), { recursive: true });
  await writeFile(join(contentsDir, 'MyGame', 'game', 'script.rpy'), 'label start:');

  const listing = zipListing([zipEntry('MyGame/'), zipEntry('MyGame/game/script.rpy')]);
  const tools = await installFakeArchiveTools({ listing, contentsDir });
  t.after(() => tools.restore());

  const archivePath = join(root, 'sample.zip');
  await writeFile(archivePath, 'ARCHIVE');

  const result = await extractArchiveToStaging({
    archivePath,
    originalName: 'sample.zip',
    type: 'zip',
    stagingRoot,
    logger: silentLogger,
  });

  assert.equal(result.folderName, 'MyGame');
  assert.ok(result.stagingId.startsWith('MyGame-'));
  assert.equal(result.path, join(stagingRoot, result.stagingId));
  assert.equal(await exists(join(result.path, 'game', 'script.rpy')), true);

  // GAMES_PATH is never written.
  assert.deepEqual(await readdir(gamesPath), []);
  // No work-dir residue; only the single staging directory remains.
  assert.deepEqual(await readdir(stagingRoot), [result.stagingId]);
});

test('same filename/title imports get isolated staging directories', async (t) => {
  const { root, gamesPath, stagingRoot, contentsDir } = await fixture(t);
  await mkdir(join(contentsDir, 'MyGame', 'game'), { recursive: true });
  await writeFile(join(contentsDir, 'MyGame', 'game', 'script.rpy'), 'label start:');

  const listing = zipListing([zipEntry('MyGame/'), zipEntry('MyGame/game/script.rpy')]);
  const tools = await installFakeArchiveTools({ listing, contentsDir });
  t.after(() => tools.restore());

  const archivePath = join(root, 'sample.zip');
  await writeFile(archivePath, 'ARCHIVE');

  const first = await extractArchiveToStaging({
    archivePath,
    originalName: 'sample.zip',
    type: 'zip',
    stagingRoot,
    logger: silentLogger,
  });
  const second = await extractArchiveToStaging({
    archivePath,
    originalName: 'sample.zip',
    type: 'zip',
    stagingRoot,
    logger: silentLogger,
  });

  assert.equal(first.folderName, second.folderName);
  assert.notEqual(first.stagingId, second.stagingId);
  assert.notEqual(first.path, second.path);
  assert.equal(await exists(join(first.path, 'game', 'script.rpy')), true);
  assert.equal(await exists(join(second.path, 'game', 'script.rpy')), true);

  const entries = await readdir(stagingRoot);
  assert.equal(entries.length, 2);
  assert.ok(entries.includes(first.stagingId));
  assert.ok(entries.includes(second.stagingId));
  assert.deepEqual(await readdir(gamesPath), []);
});

test('failed/unavailable safe ZIP inspection means no extraction and no residue', async (t) => {
  const { root, gamesPath, stagingRoot, contentsDir } = await fixture(t);
  await mkdir(join(contentsDir, 'MyGame', 'game'), { recursive: true });
  await writeFile(join(contentsDir, 'MyGame', 'game', 'script.rpy'), 'label start:');

  const listing = zipListing([zipEntry('MyGame/'), zipEntry('MyGame/game/script.rpy')]);
  const tools = await installFakeArchiveTools({ listing, contentsDir, zipinfoExit: 1 });
  t.after(() => tools.restore());

  const archivePath = join(root, 'sample.zip');
  await writeFile(archivePath, 'ARCHIVE');

  let error;
  try {
    await extractArchiveToStaging({
      archivePath,
      originalName: 'sample.zip',
      type: 'zip',
      stagingRoot,
      logger: silentLogger,
    });
  } catch (err) {
    error = err;
  }

  assert.ok(error, 'expected inspection to fail');
  assert.equal(error.code, 'ARCHIVE_INSPECTION_FAILED');

  // unzip -l is available (fake unzip supports it) but must not be used as a
  // safety fallback: nothing was extracted and staging is clean.
  assert.deepEqual(await readdir(stagingRoot).catch(() => []), []);
  assert.deepEqual(await readdir(gamesPath), []);
});

test('traversal and escaping-link archives are rejected before extraction', async (t) => {
  const { root, gamesPath, stagingRoot, contentsDir } = await fixture(t);

  const listing = zipListing(
    [
      zipEntry('MyGame/game/script.rpy'),
      'lrwxrwxrwx  3.0 unx   0  bx defN 24-Jan-01 12:00 MyGame/game/link -> ../../../outside',
    ]
  );
  const tools = await installFakeArchiveTools({ listing, contentsDir });
  t.after(() => tools.restore());

  const archivePath = join(root, 'sample.zip');
  await writeFile(archivePath, 'ARCHIVE');

  await assert.rejects(
    () =>
      extractArchiveToStaging({
        archivePath,
        originalName: 'sample.zip',
        type: 'zip',
        stagingRoot,
        logger: silentLogger,
      }),
    /Unsafe symlink/
  );

  assert.deepEqual(await readdir(gamesPath), []);
  assert.deepEqual(await readdir(stagingRoot).catch(() => []), []);
});

test('failed extraction cleans staging and leaves the source archive untouched', async (t) => {
  const { root, gamesPath, stagingRoot, contentsDir } = await fixture(t);
  const listing = zipListing([zipEntry('MyGame/'), zipEntry('MyGame/game/script.rpy')]);
  const tools = await installFakeArchiveTools({ listing, contentsDir });
  t.after(() => tools.restore());

  const archivePath = join(root, 'sample.zip');
  await writeFile(archivePath, 'ARCHIVE-BYTES');

  process.env.FAKE_EXTRACT_EXIT = '1';
  try {
    await assert.rejects(
      () =>
        extractArchiveToStaging({
          archivePath,
          originalName: 'sample.zip',
          type: 'zip',
          stagingRoot,
          logger: silentLogger,
        }),
      /Command failed|exited/
    );
  } finally {
    delete process.env.FAKE_EXTRACT_EXIT;
  }

  // Source archive untouched, staging cleaned.
  assert.equal(await readFile(archivePath, 'utf8'), 'ARCHIVE-BYTES');
  assert.deepEqual(await readdir(gamesPath), []);
  assert.deepEqual(await readdir(stagingRoot).catch(() => []), []);
});

test('resolveImportStagingRoot prefers the configured path, else WEB_BUILDS_PATH/imports', () => {
  assert.equal(resolveImportStagingRoot({ basePath: '/web-builds' }), '/web-builds/imports');
  assert.equal(resolveImportStagingRoot({ basePath: '/web-builds', configuredPath: '/srv/imports' }), '/srv/imports');
});
