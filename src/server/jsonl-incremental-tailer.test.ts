// Locks down the tailer's trickiest invariants: byte ranges must be true file
// positions across multi-chunk appends with partial-line carry, multi-byte
// UTF-8 split across reads, and the truncation reset path.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlIncrementalTailer, type TailedRecord } from './jsonl-incremental-tailer';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function makeFile(content: string): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'kansh-tailer-'));
  const path = join(dir, 'session.jsonl');
  await writeFile(path, content);
  return path;
}

/** Assert a record's byte range re-reads to exactly its JSON line. */
async function verifyRange(path: string, tailed: TailedRecord): Promise<void> {
  const whole = Buffer.from(await Bun.file(path).arrayBuffer());
  const slice = whole.subarray(tailed.byteStart, tailed.byteEnd).toString('utf8');
  expect(JSON.parse(slice)).toEqual(tailed.record);
}

describe('JsonlIncrementalTailer byte ranges', () => {
  test('single read: ranges re-read to the same records', async () => {
    const path = await makeFile('{"a":1}\n{"b":"xin chào 👋"}\n');
    const tailer = new JsonlIncrementalTailer();
    await tailer.track(path);
    const records = await tailer.readNew(path);
    expect(records.map((r) => r.record)).toEqual([{ a: 1 }, { b: 'xin chào 👋' }]);
    for (const r of records) await verifyRange(path, r);
  });

  test('partial-line carry across appends keeps ranges correct', async () => {
    const path = await makeFile('{"first":true}\n{"sec');
    const tailer = new JsonlIncrementalTailer();
    await tailer.track(path);
    const first = await tailer.readNew(path);
    expect(first.map((r) => r.record)).toEqual([{ first: true }]);

    await appendFile(path, 'ond":2}\n{"third":3}\n');
    const rest = await tailer.readNew(path);
    expect(rest.map((r) => r.record)).toEqual([{ second: 2 }, { third: 3 }]);
    for (const r of [...first, ...rest]) await verifyRange(path, r);
  });

  test('multi-byte UTF-8 split across the append boundary survives', async () => {
    const full = `{"emoji":"trước👋sau"}\n`;
    const bytes = Buffer.from(full, 'utf8');
    const splitAt = full.indexOf('👋') + 2; // char offset — cut inside the 4-byte emoji
    const byteSplit = Buffer.from(full.slice(0, full.indexOf('👋')), 'utf8').length + 2;
    void splitAt;
    const path = await makeFile('');
    await appendFile(path, bytes.subarray(0, byteSplit));
    const tailer = new JsonlIncrementalTailer();
    await tailer.track(path);
    expect(await tailer.readNew(path)).toEqual([]); // incomplete line buffered

    await appendFile(path, bytes.subarray(byteSplit));
    const records = await tailer.readNew(path);
    expect(records.map((r) => r.record)).toEqual([{ emoji: 'trước👋sau' }]);
    await verifyRange(path, records[0]);
  });

  test('truncation resets offset and partial; ranges restart from zero', async () => {
    const path = await makeFile('{"old":1}\n{"old":2}\n');
    const tailer = new JsonlIncrementalTailer();
    await tailer.track(path);
    await tailer.readNew(path);

    await writeFile(path, '{"new":1}\n'); // shrink → rewrite
    const records = await tailer.readNew(path);
    expect(records.map((r) => r.record)).toEqual([{ new: 1 }]);
    expect(records[0].byteStart).toBe(0);
    await verifyRange(path, records[0]);
  });

  test('malformed lines are skipped without derailing later ranges', async () => {
    const path = await makeFile('{"ok":1}\nnot json at all\n{"ok":2}\n');
    const tailer = new JsonlIncrementalTailer();
    await tailer.track(path);
    const records = await tailer.readNew(path);
    expect(records.map((r) => r.record)).toEqual([{ ok: 1 }, { ok: 2 }]);
    for (const r of records) await verifyRange(path, r);
  });
});
