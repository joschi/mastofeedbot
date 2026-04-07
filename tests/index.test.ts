import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';

import { sha256, filterCachedItems, getCache, writeCache } from '../src/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('sha256', () => {
  test('produces a known hex digest', () => {
    assert.strictEqual(
      sha256('https://github.com/joschi/mastofeedbot/pull/1'),
      '551d666da11667a7061a9fbe0f4330573950eb0e367cac3509254a0d5196b4b2'
    );
  });

  test('different inputs produce different hashes', () => {
    assert.notStrictEqual(sha256('foo'), sha256('bar'));
  });

  test('same input always produces the same hash', () => {
    assert.strictEqual(sha256('hello'), sha256('hello'));
  });
});

describe('filterCachedItems', () => {
  const makeEntry = (link: string, published: string): FeedEntry => ({
    id: sha256(link),
    link,
    title: `Title for ${link}`,
    published,
  });

  const entries: FeedEntry[] = [
    makeEntry('https://example.com/1', '2022-12-15T19:02:13.000Z'),
    makeEntry('https://example.com/2', '2022-12-27T19:02:13.000Z'),
  ];

  test('returns all items when cache is empty', async () => {
    const result = await filterCachedItems(entries, []);
    assert.strictEqual(result.length, 2);
  });

  test('filters out cached items', async () => {
    const cachedHash = sha256('https://example.com/1');
    const result = await filterCachedItems(entries, [cachedHash]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].link, 'https://example.com/2');
  });

  test('returns empty array when all items are cached', async () => {
    const cache = entries.map(e => sha256(e.link as string));
    const result = await filterCachedItems(entries, cache);
    assert.strictEqual(result.length, 0);
  });

  test('sorts results by published date ascending when cache is used', async () => {
    const unsorted: FeedEntry[] = [
      makeEntry('https://example.com/b', '2023-01-02T00:00:00.000Z'),
      makeEntry('https://example.com/a', '2023-01-01T00:00:00.000Z'),
    ];
    // passing a non-empty but non-matching cache triggers the filter+sort path
    const result = await filterCachedItems(unsorted, ['dummy-hash-not-in-feed']);
    assert.strictEqual(result[0].link, 'https://example.com/a');
    assert.strictEqual(result[1].link, 'https://example.com/b');
  });

  test('works with XML fixture data', async () => {
    const xml = readFileSync(join(__dirname, 'simple.xml'), 'utf-8');
    const feedData = extractFromXml(xml);
    const feedEntries = feedData.entries as FeedEntry[];
    assert.strictEqual(feedEntries.length, 2);

    // cache the first item
    const firstHash = sha256(feedEntries[0].link as string);
    const result = await filterCachedItems(feedEntries, [firstHash]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].link, 'https://github.com/joschi/mastofeedbot/pull/2');
  });
});

describe('getCache', () => {
  test('returns empty array when cache file does not exist', async () => {
    const nonExistent = join(tmpdir(), `mastofeedbot-test-nonexistent-${Date.now()}.json`);
    const cache = await getCache(nonExistent);
    assert.deepStrictEqual(cache, []);
  });

  test('reads and parses an existing cache file', async () => {
    const tmpFile = join(tmpdir(), `mastofeedbot-test-cache-${Date.now()}.json`);
    const expected = ['hash1', 'hash2', 'hash3'];
    await writeFile(tmpFile, JSON.stringify(expected), 'utf-8');
    try {
      const cache = await getCache(tmpFile);
      assert.deepStrictEqual(cache, expected);
    } finally {
      await rm(tmpFile);
    }
  });
});

describe('writeCache', () => {
  test('writes cache to file', async () => {
    const tmpDir = join(tmpdir(), `mastofeedbot-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'cache.json');
    const cache = ['hash1', 'hash2'];
    try {
      await writeCache(tmpFile, 100, cache);
      assert.ok(existsSync(tmpFile));
      const written = await getCache(tmpFile);
      assert.deepStrictEqual(written, cache);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test('truncates cache when it exceeds the limit', async () => {
    const tmpDir = join(tmpdir(), `mastofeedbot-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'cache.json');
    const cache = ['hash1', 'hash2', 'hash3', 'hash4', 'hash5'];
    const limit = 3;
    try {
      await writeCache(tmpFile, limit, cache);
      const written = await getCache(tmpFile);
      assert.strictEqual(written.length, limit);
      // should keep the last `limit` items
      assert.deepStrictEqual(written, ['hash3', 'hash4', 'hash5']);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test('does not truncate when cache is within limit', async () => {
    const tmpDir = join(tmpdir(), `mastofeedbot-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'cache.json');
    const cache = ['hash1', 'hash2'];
    try {
      await writeCache(tmpFile, 10, cache);
      const written = await getCache(tmpFile);
      assert.deepStrictEqual(written, cache);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });
});

describe('entity expansion limit', () => {
  test('fails when entity expansion limit is exceeded', () => {
    const xml = readFileSync(join(__dirname, 'entities.xml'), 'utf-8');
    assert.throws(
      () => extractFromXml(xml, { xmlParserOptions: { processEntities: { maxTotalExpansions: 5 } } }),
      /Entity expansion limit exceeded/
    );
  });

  test('succeeds when entity expansion limit is raised', () => {
    const xml = readFileSync(join(__dirname, 'entities.xml'), 'utf-8');
    const result = extractFromXml(xml, { xmlParserOptions: { processEntities: { maxTotalExpansions: 20 } } });
    assert.ok(result);
    assert.strictEqual(result.entries?.length, 1);
  });
});
