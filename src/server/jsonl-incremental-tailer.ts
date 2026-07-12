// Incremental JSONL reader: remembers a byte offset per file and reads only
// newly appended bytes. The partial trailing line is carried as a Buffer (not
// a string) so multi-byte UTF-8 sequences split across reads survive intact.
// Files are opened per-read (claude appends and closes, so holding
// descriptors open buys nothing).

import { open, stat } from 'node:fs/promises';

const NEWLINE = 0x0a;

interface TailState {
  offset: number;
  /** incomplete trailing line bytes carried over to the next read */
  partial: Buffer;
}

/** A parsed record plus the byte range it occupies in the file (for lazy re-reads). */
export interface TailedRecord {
  record: unknown;
  byteStart: number;
  byteEnd: number;
}

export class JsonlIncrementalTailer {
  private states = new Map<string, TailState>();
  /** count of lines dropped due to JSON parse failure (logged, rate-limited) */
  private droppedLineCount = 0;

  /** True if the tailer already tracks this file. */
  has(path: string): boolean {
    return this.states.has(path);
  }

  /**
   * Start tracking a file. When `fromByte` is provided, reading starts there
   * (used to replay only the tail of large historical transcripts).
   */
  async track(path: string, fromByte = 0): Promise<void> {
    if (this.states.has(path)) return;
    this.states.set(path, { offset: fromByte, partial: Buffer.alloc(0) });
  }

  /**
   * Read appended content since the last call. Returns parsed JSON records
   * with their byte ranges, skipping lines that fail to parse (defensive
   * against partial writes and future format changes). Offset advances only
   * by bytes actually read.
   */
  async readNew(path: string): Promise<TailedRecord[]> {
    const state = this.states.get(path);
    if (!state) return [];

    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return []; // file vanished; keep state in case it reappears
    }

    if (size < state.offset) {
      // file truncated/rewritten — restart from beginning
      state.offset = 0;
      state.partial = Buffer.alloc(0);
    }
    if (size === state.offset) return [];

    const wanted = size - state.offset;
    const buffer = Buffer.alloc(wanted);
    let totalRead = 0;
    let fh;
    try {
      fh = await open(path, 'r');
      // pread may return fewer bytes than requested — loop until done or EOF
      while (totalRead < wanted) {
        const { bytesRead } = await fh.read(buffer, totalRead, wanted - totalRead, state.offset + totalRead);
        if (bytesRead === 0) break;
        totalRead += bytesRead;
      }
    } catch {
      return [];
    } finally {
      await fh?.close();
    }
    if (totalRead === 0) return [];
    // file position of data[0]: pre-read offset minus the carried partial bytes
    const dataFileStart = state.offset - state.partial.length;
    state.offset += totalRead;

    const data = Buffer.concat([state.partial, buffer.subarray(0, totalRead)]);
    const lastNewline = data.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      state.partial = data; // no complete line yet
      return [];
    }
    state.partial = data.subarray(lastNewline + 1);

    const records: TailedRecord[] = [];
    let lineStart = 0;
    while (lineStart <= lastNewline) {
      let lineEnd = data.indexOf(NEWLINE, lineStart);
      if (lineEnd === -1 || lineEnd > lastNewline) lineEnd = lastNewline;
      const line = data.subarray(lineStart, lineEnd).toString('utf8').trim();
      if (line) {
        try {
          records.push({
            record: JSON.parse(line),
            byteStart: dataFileStart + lineStart,
            byteEnd: dataFileStart + lineEnd,
          });
        } catch {
          this.droppedLineCount++;
          if (this.droppedLineCount <= 20 || this.droppedLineCount % 100 === 0) {
            console.warn(`[tailer] dropped unparseable line #${this.droppedLineCount} in ${path}`);
          }
        }
      }
      lineStart = lineEnd + 1;
    }
    return records;
  }

  untrack(path: string): void {
    this.states.delete(path);
  }

  /** Paths currently tracked (used for eviction bookkeeping). */
  trackedPaths(): string[] {
    return [...this.states.keys()];
  }
}
