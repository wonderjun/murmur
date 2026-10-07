/**
 * 接入诊断单测：probePath 三态与 sqlite 探测、deriveHint 优先级分支、
 * selfTestPayload 经各 adapter 真翻译出事件（payload 失真立刻被抓）。
 * preload 已钉沙箱 env——adapter 工厂构造无副作用，translate 纯函数。
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentAdapter } from '../src/agents/base';
import { createCodexAdapter } from '../src/agents/codex';
import { createCursorAdapter } from '../src/agents/cursor';
import { createDevinAdapter } from '../src/agents/devin';
import { createKimiAdapter } from '../src/agents/kimi';
import { createMinimaxAdapter } from '../src/agents/minimax';
import { createOmpAdapter } from '../src/agents/omp';
import { createOpencodeAdapter } from '../src/agents/opencode';
import { createQoderAdapter } from '../src/agents/qoder';
import { createZcodeAdapter } from '../src/agents/zcode';
import { deriveHint, probePath, selfTestPayload } from '../src/engine/diagnostics';
import type { AgentDiagnostics, AgentId } from '../src/types';

const dir = mkdtempSync(join(tmpdir(), 'murmur-diag-'));

describe('probePath', () => {
  test('路径缺失 → exists:false，不再后续探测', () => {
    const p = probePath('x', join(dir, 'nope'), 'dir');
    expect(p.exists).toBe(false);
    expect(p.readable).toBe(false);
    expect(p.openable).toBeUndefined();
  });

  test('空路径 → note 标未配置', () => {
    expect(probePath('x', '', 'file').note).toBe('路径未配置');
  });

  test('存在的目录 → exists+readable', () => {
    const p = probePath('x', dir, 'dir');
    expect(p).toMatchObject({ exists: true, readable: true });
  });

  test('真 sqlite → openable:true；垃圾文件 → openable:false', () => {
    const dbPath = join(dir, 'ok.sqlite');
    new Database(dbPath).close();
    expect(probePath('db', dbPath, 'sqlite').openable).toBe(true);

    const badPath = join(dir, 'bad.sqlite');
    writeFileSync(badPath, 'not a sqlite file at all');
    const bad = probePath('db', badPath, 'sqlite');
    expect(bad.openable).toBe(false);
    expect(bad.note).toContain('无法只读打开');
  });
});

function diag(over: Partial<AgentDiagnostics> = {}): AgentDiagnostics {
  return {
    agent: 'kimi',
    home: { label: '数据根', path: dir, kind: 'dir', exists: true, readable: true },
    sources: [{ label: '会话', path: join(dir, 'sessions'), kind: 'dir', exists: true, readable: true }],
    hook: { installed: false, enabled: true, targets: [], lastEventAt: null },
    pull: { active: true, lastScanAt: Date.now(), sources: [{ name: 'wire.jsonl', at: Date.now() }] },
    spool: { pendingFiles: 0, bytes: 0 },
    hint: '',
    ...over,
  };
}

describe('deriveHint 优先级', () => {
  const base = { observed: true, installed: true };

  test('未安装 > 停用 > spool > 数据源异常 > 无数据 > 未扫过 > 停滞 > hook > 正常', () => {
    expect(deriveHint(diag(), { ...base, installed: false })).toContain('未发现数据目录');
    expect(deriveHint(diag(), { ...base, observed: false })).toBe('已在设置中停用监听');
    expect(deriveHint(diag({ spool: { pendingFiles: 1, bytes: 100 } }), base)).toContain('暂存');
    expect(
      deriveHint(diag({ sources: [{ label: '任务库', path: dir, kind: 'sqlite', exists: true, readable: true, openable: false }] }), base),
    ).toContain('任务库');
    expect(
      deriveHint(diag({ sources: [{ label: 's', path: '/x', kind: 'dir', exists: false, readable: false }] }), base),
    ).toContain('还没有本地数据');
    expect(deriveHint(diag({ pull: { active: true, lastScanAt: null, sources: [] } }), base)).toContain('尚未扫描');
    // hook 提示只在有 push 面（targets 非空）时进入；targets 空表 = 纯 pull agent。
    const hookTargets = [join(dir, 'hooks.json')];
    expect(deriveHint(diag({ hook: { installed: false, enabled: true, targets: hookTargets, lastEventAt: null } }), base)).toContain(
      'hook 未注入',
    );
    expect(deriveHint(diag({ hook: { installed: true, enabled: true, targets: hookTargets, lastEventAt: null } }), base)).toContain(
      '尚未收到上报',
    );
    expect(
      deriveHint(diag({ hook: { installed: true, enabled: true, targets: hookTargets, lastEventAt: Date.now() } }), base),
    ).toBe('数据源正常——暂无活跃会话');
    // 纯 pull（targets 空表）的 agent 永不报 hook 异常——正常态直出。
    expect(deriveHint(diag({ hook: { installed: false, enabled: true, targets: [], lastEventAt: null } }), base)).toBe(
      '数据源正常——暂无活跃会话',
    );
  });

  test('停滞判定：游标超窗未推进 + 源 mtime 新鲜 → 建议重扫', () => {
    const fresh = join(dir, 'sessions');
    writeFileSync(fresh, 'x'); // mtime=now → 新鲜
    const stale = diag({
      sources: [{ label: '会话', path: fresh, kind: 'file', exists: true, readable: true }],
      pull: { active: true, lastScanAt: Date.now() - 20 * 60_000, sources: [{ name: 's', at: Date.now() - 20 * 60_000 }] },
    });
    expect(deriveHint(stale, base)).toContain('停滞');
  });
});

describe('selfTestPayload × 各家 adapter', () => {
  const adapters: AgentAdapter[] = [
    createKimiAdapter(),
    createZcodeAdapter(),
    createOpencodeAdapter(),
    createCodexAdapter(),
    createCursorAdapter(),
    createDevinAdapter(),
    createQoderAdapter(),
    createMinimaxAdapter(),
    createOmpAdapter(),
  ];

  for (const a of adapters) {
    test(`${a.id} marker 能翻出 ≥1 条 sessionId 对齐的事件`, () => {
      // 纯 pull agent（无 hook 面）自检不适用——断无 translateHook 即过。
      if (!a.translateHook) {
        expect(a.hookTargets?.() ?? []).toEqual([]);
        return;
      }
      const sid = `murmur-selftest:${a.id}`;
      const events = a.translateHook(selfTestPayload(a.id as AgentId, sid));
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.sessionId === sid)).toBe(true);
      // 台账腿要求 LEDGER_KINDS 成员——session.start 满足。
      expect(events.some((e) => e.kind === 'session.start')).toBe(true);
    });
  }
});
