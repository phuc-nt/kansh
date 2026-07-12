// Smoke test in two parts:
// A) fixture test: synthetic projects root (malformed lines, subagent spawn/close,
//    meta noise) with hard assertions — no writes to ~/.claude, ever.
// B) real-data test against local ~/.claude: discovery, liveness, WS snapshot.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionStateStore } from '../src/server/session-state-store';
import { SessionTranscriptIngestion } from '../src/server/session-transcript-ingestion';
import { sampleClaudeProcesses } from '../src/server/session-liveness-poller';
import { startWebsocketHub } from '../src/server/websocket-hub';

const TEST_PORT = 4778;
const failures: string[] = [];
const assert = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};

// ---------- Part A: fixture test ----------
const FIXTURE_ROOT = join(import.meta.dir, '..', '.smoke-fixture-projects');
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TOOL_USE_ID = 'toolu_fixture01';

async function buildFixture(): Promise<void> {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
  const projectDir = join(FIXTURE_ROOT, '-tmp-fixture-project');
  const subagentsDir = join(projectDir, SESSION_ID, 'subagents');
  await mkdir(subagentsDir, { recursive: true });

  const t = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const mainLines = [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: t(0), sessionId: SESSION_ID, cwd: '/tmp/fixture', slug: 'fixture-slug', entrypoint: 'cli', message: { content: 'hello world — xin chào 👋' } }),
    '{ this is not valid json at all',
    JSON.stringify({ type: 'user', uuid: 'u2', timestamp: t(1), sessionId: SESSION_ID, isMeta: true, message: { content: '<command-name>noise</command-name>' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: t(2), sessionId: SESSION_ID, message: { content: [{ type: 'text', text: 'working on it' }, { type: 'tool_use', id: TOOL_USE_ID, name: 'Task', input: { description: 'spawn reviewer' } }] } }),
    JSON.stringify({ type: 'user', uuid: 'u3', timestamp: t(10), sessionId: SESSION_ID, message: { content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: 'done' }] } }),
    JSON.stringify({ type: 'totally-unknown-future-type', uuid: 'x1', timestamp: t(11) }),
  ];
  await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), mainLines.join('\n') + '\n');

  await writeFile(
    join(subagentsDir, 'agent-abc123.meta.json'),
    JSON.stringify({ agentType: 'code-reviewer', description: 'fixture reviewer', toolUseId: TOOL_USE_ID, spawnDepth: 1 }),
  );
  await writeFile(
    join(subagentsDir, 'agent-abc123.jsonl'),
    JSON.stringify({ type: 'assistant', uuid: 's1', timestamp: t(5), sessionId: SESSION_ID, agentId: 'abc123', isSidechain: true, message: { content: [{ type: 'text', text: 'reviewing' }] } }) + '\n',
  );
}

await buildFixture();
const fixtureStore = new SessionStateStore({ onSessionAdded: () => {}, onEvent: () => {}, onStatusChange: () => {}, onSemanticsChange: () => {} });
const fixtureIngestion = new SessionTranscriptIngestion(fixtureStore, FIXTURE_ROOT);
await fixtureIngestion.start();
fixtureIngestion.stop();

const fixtureSessions = fixtureStore.snapshotAll();
assert(fixtureSessions.length === 1, `fixture: expected 1 session, got ${fixtureSessions.length}`);
const fx = fixtureSessions[0];
if (fx) {
  const kinds = fx.events.map((e) => e.kind);
  assert(fx.cwd === '/tmp/fixture' && fx.slug === 'fixture-slug', 'fixture: meta (cwd/slug) not scraped');
  assert(kinds.includes('user-message'), 'fixture: user-message missing');
  assert(kinds.includes('tool-start'), 'fixture: tool-start missing');
  assert(kinds.includes('tool-end'), 'fixture: tool-end missing');
  assert(kinds.includes('subagent-spawn'), 'fixture: subagent-spawn missing');
  assert(kinds.includes('subagent-end'), 'fixture: subagent-end missing (branch never closes)');
  const spawn = fx.events.find((e) => e.kind === 'subagent-spawn');
  assert(spawn?.toolUseId === TOOL_USE_ID && spawn?.agentType === 'code-reviewer', 'fixture: spawn lacks toolUseId/agentType');
  assert(!fx.events.some((e) => e.label?.includes('<command-name>')), 'fixture: meta/noise record leaked into events');
  const seqs = fx.events.map((e) => e.seq);
  assert(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'fixture: seq not monotonic in apply order');
  // malformed + unknown-type lines must be skipped without crashing (we got here) — count sanity:
  assert(fx.events.length >= 5, `fixture: expected >=5 events, got ${fx.events.length}`);
}
await rm(FIXTURE_ROOT, { recursive: true, force: true });
console.log(`fixture: ${fx?.events.length ?? 0} events, assertions ${failures.length === 0 ? 'ok' : 'FAILED'}`);

// ---------- Part B: real local data ----------
const store = new SessionStateStore({ onSessionAdded: () => {}, onEvent: () => {}, onStatusChange: () => {}, onSemanticsChange: () => {} });
const ingestion = new SessionTranscriptIngestion(store);
await ingestion.start();

const sample = await sampleClaudeProcesses();
store.applyLivenessSample(sample);

const sessions = store.snapshotAll();
const totalEvents = sessions.reduce((n, s) => n + s.events.length, 0);
const byStatus = { running: 0, waiting: 0, ended: 0 };
for (const s of sessions) byStatus[s.status]++;

console.log(`sessions(24h): ${sessions.length} | events: ${totalEvents}`);
console.log(`status: running=${byStatus.running} waiting=${byStatus.waiting} ended=${byStatus.ended}`);
console.log(`claude processes: ${sample.claudeProcessCount}, resumed: ${sample.resumedSessionIds.size}, fresh cwds: ${sample.freshProcessCwds.size}`);

// usage/model aggregation must produce non-zero data on real transcripts
const withTokens = sessions.filter((s) => s.totalTokensIn + s.totalTokensOut > 0);
const withModel = sessions.filter((s) => s.model !== '');
console.log(`sessions with tokens: ${withTokens.length}, with model: ${withModel.length}, ctx sample: ${sessions[0]?.contextTokens ?? 0}`);
assert(withTokens.length > 0, 'real: no session accumulated any token usage');
assert(withModel.length > 0, 'real: no session captured a model name');

// semantic layer must extract real content from live transcripts
const withMission = sessions.filter((s) => (s.mission ?? '').length > 0);
const withTodos = sessions.filter((s) => (s.todos?.length ?? 0) > 0);
console.log(`semantics: mission=${withMission.length}/${sessions.length}, todos=${withTodos.length}, streak sample=${sessions[0]?.errorStreak}`);
assert(withMission.length > 0, 'real: no session extracted a mission');
assert(withTodos.length > 0, 'real: no session extracted todos (TodoWrite is ubiquitous)');

const spawns = sessions.flatMap((s) => s.events.filter((e) => e.kind === 'subagent-spawn'));
const spawnsWithLink = spawns.filter((e) => e.toolUseId && e.agentType);
const ends = sessions.flatMap((s) => s.events.filter((e) => e.kind === 'subagent-end'));
console.log(`subagent spawns: ${spawns.length} (linked: ${spawnsWithLink.length}), ends: ${ends.length}`);

assert(sessions.length > 0, 'real: no sessions discovered (expected >0 on this machine)');
assert(totalEvents > 0, 'real: no events parsed');
if (spawns.length > 0) {
  assert(spawnsWithLink.length > 0, 'real: no spawn carries toolUseId+agentType');
  assert(ends.length > 0, 'real: spawns exist but no subagent-end closures at all');
}
if (sample.claudeProcessCount > 0) {
  assert(byStatus.running + byStatus.waiting > 0, 'real: claude processes exist but no session running/waiting');
}

// WS round-trip
const hub = startWebsocketHub({ port: TEST_PORT, store });
const snapshotSessions = await new Promise<number>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
  const timeout = setTimeout(() => reject(new Error('snapshot timeout')), 5000);
  ws.onmessage = (msg) => {
    const parsed = JSON.parse(String(msg.data));
    if (parsed.type === 'snapshot') {
      clearTimeout(timeout);
      ws.close();
      resolve(parsed.sessions.length);
    }
  };
  ws.onerror = () => reject(new Error('ws error'));
});
console.log(`ws snapshot sessions: ${snapshotSessions}`);
assert(snapshotSessions === sessions.length, 'real: ws snapshot count mismatch');

ingestion.stop();
hub.server.stop(true);

if (failures.length > 0) {
  console.error('SMOKE FAIL:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('SMOKE PASS');
process.exit(0);
