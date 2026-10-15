import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_ID, backupsToKeep } from '../src/backup.ts';

const now = new Date(2026, 9, 14, 20, 0, 0);
const hoursAgo = (h: number, pinned = false) => ({ id: `h${h}`, createdAt: new Date(now.getTime() - h * 3600_000), pinned });

test('stündliche Backups der letzten 24 Stunden bleiben alle', () => {
  const backups = Array.from({ length: 24 }, (_, h) => hoursAgo(h));
  assert.equal(backupsToKeep(backups, now, 24, 14).size, 24);
});

test('ältere Backups: nur das neueste pro Tag, höchstens 14 Tage', () => {
  // 30 Tage lang stündlich
  const backups = Array.from({ length: 30 * 24 }, (_, h) => hoursAgo(h));
  const keep = backupsToKeep(backups, now, 24, 14);
  const kept = backups.filter((b) => keep.has(b.id));
  const older = kept.filter((b) => now.getTime() - b.createdAt.getTime() > 24 * 3600_000);
  // je Kalendertag höchstens eins
  const days = older.map((b) => b.createdAt.toDateString());
  assert.equal(new Set(days).size, days.length);
  // nichts älter als 14 Tage
  assert.ok(kept.every((b) => now.getTime() - b.createdAt.getTime() <= 14 * 86400_000));
  // pro Tag das neueste (z. B. 23:00 Uhr)
  assert.ok(older.every((b) => b.createdAt.getHours() === 23));
});

test('angepinnte Backups und das neueste bleiben immer', () => {
  const old = hoursAgo(24 * 60, true);
  assert.ok(backupsToKeep([old, hoursAgo(24 * 90)], now, 24, 14).has(old.id));
  // Einziges Backup ist uralt → bleibt trotzdem (nie ohne Backup dastehen)
  assert.deepEqual([...backupsToKeep([hoursAgo(24 * 90)], now, 24, 14)], ['h2160']);
});

test('Backup-IDs schützen vor Pfad-Tricks', () => {
  assert.ok(BACKUP_ID.test('2026-10-14_19-30-00'));
  assert.ok(!BACKUP_ID.test('../../etc'));
  assert.ok(!BACKUP_ID.test('2026-10-14_19-30-00/../x'));
});

import { checkPackageListing } from '../src/migration.ts';

test('Umzugspaket: nur ein Backup-Ordner, keine Links, keine Pfade nach außen', () => {
  const ok = [
    'drwxr-xr-x root/root         0 2026-10-14 23:18 2026-10-14_23-18-28/',
    '-rw-r--r-- root/root  25000000 2026-10-14 23:18 2026-10-14_23-18-28/world.tar.gz',
    '-rw-r--r-- root/root      1234 2026-10-14 23:18 2026-10-14_23-18-28/items/stone.png',
  ].join('\n');
  assert.deepEqual(checkPackageListing(ok), { id: '2026-10-14_23-18-28' });
  assert.ok('error' in checkPackageListing(ok + '\nlrwxrwxrwx root/root 0 2026-10-14 23:18 2026-10-14_23-18-28/x -> /etc/passwd'));
  assert.ok('error' in checkPackageListing('-rw-r--r-- root/root 1 2026-10-14 23:18 2026-10-14_23-18-28/../../etc/x'));
  assert.ok('error' in checkPackageListing('-rw-r--r-- root/root 1 2026-10-14 23:18 /etc/x'));
  assert.ok('error' in checkPackageListing('-rw-r--r-- root/root 1 2026-10-14 23:18 irgendwas/x'));
  assert.ok('error' in checkPackageListing(ok + '\n-rw-r--r-- root/root 1 2026-10-14 23:18 2026-10-15_00-00-00/x'));
  assert.ok('error' in checkPackageListing(''));
});
