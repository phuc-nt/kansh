// Lazy event detail: events carry only short labels; the full record is
// re-read from its transcript byte range on demand. The index is capped so a
// long-running daemon stays memory-bounded — details for evicted entries
// simply return null and the UI shows the event's own fields.

import { open } from 'node:fs/promises';

interface RecordLocation {
  path: string;
  byteStart: number;
  byteEnd: number;
}

const MAX_INDEX_ENTRIES = 20_000;
/** cap any single string field in the returned detail */
const STRING_TRUNCATE_AT = 2048;

export class EventDetailReader {
  /** event uuid -> transcript byte range; Map insertion order = FIFO eviction */
  private index = new Map<string, RecordLocation>();
  /** synthetic events (subagent spawns) have no byte range — store detail directly */
  private synthetic = new Map<string, unknown>();

  register(uuid: string, location: RecordLocation): void {
    if (this.index.has(uuid)) return;
    this.index.set(uuid, location);
    if (this.index.size > MAX_INDEX_ENTRIES) {
      const oldest = this.index.keys().next().value;
      if (oldest !== undefined) this.index.delete(oldest);
    }
  }

  /** Store a pre-built detail object for events with no transcript record. */
  registerSynthetic(uuid: string, detail: unknown): void {
    if (this.synthetic.has(uuid)) return;
    this.synthetic.set(uuid, truncateStrings(detail));
    if (this.synthetic.size > MAX_INDEX_ENTRIES) {
      const oldest = this.synthetic.keys().next().value;
      if (oldest !== undefined) this.synthetic.delete(oldest);
    }
  }

  /** Re-read the raw record for an event; null when unknown or unreadable. */
  async read(uuid: string): Promise<unknown | null> {
    const syntheticDetail = this.synthetic.get(uuid);
    if (syntheticDetail !== undefined) return syntheticDetail;
    const location = this.index.get(uuid);
    if (!location) return null;
    const length = location.byteEnd - location.byteStart;
    if (length <= 0 || length > 10 * 1024 * 1024) return null;

    const buffer = Buffer.alloc(length);
    let fh;
    try {
      fh = await open(location.path, 'r');
      let totalRead = 0;
      while (totalRead < length) {
        const { bytesRead } = await fh.read(buffer, totalRead, length - totalRead, location.byteStart + totalRead);
        if (bytesRead === 0) break;
        totalRead += bytesRead;
      }
      if (totalRead < length) return null;
    } catch {
      return null; // file rotated/vanished — detail unavailable
    } finally {
      await fh?.close();
    }

    try {
      return truncateStrings(JSON.parse(buffer.toString('utf8')));
    } catch {
      return null;
    }
  }
}

/** Deep-copy with every long string truncated, keeping payloads UI-safe. */
function truncateStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > STRING_TRUNCATE_AT ? value.slice(0, STRING_TRUNCATE_AT) + '… [truncated]' : value;
  }
  if (Array.isArray(value)) return value.map(truncateStrings);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateStrings(v)]));
  }
  return value;
}
