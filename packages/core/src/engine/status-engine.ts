/**
 * 会话状态机：消费归一化 AgentEvent，维护每个会话的状态与 token 台账，
 * 输出 SessionSnapshot 列表供托盘与面板渲染。
 *
 * 迁移规则：
 *   session.start              → idle
 *   turn.start                 → working(thinking)，记 turnStartAt
 *   tool.call                  → working(tool)，记 toolCallAt/toolName
 *   permission.request         → waiting(approval)，记 waitingDetail
 *   status waiting(question)   → waiting(question)，记 waitingDetail
 *   turn.end                   → waiting(turn-end)  ← 「轮到你了」信号
 *   session.end                → ended（保留 grace 期后清除）
 *   长时间无事件且 working     → stale（watchdog 周期检查）
 *
 * working 相位（phase）由事件流推导：turn.start 与 PostToolUse 系之间标
 * thinking（模型往返中），tool.call 起标 tool。是推断不是真值——排队/重试
 * 不可分辨；无细粒度源的会话 phase 恒缺省。离开 waiting 清 waitingDetail，
 * 离开 working 清 phase；statusAt 在状态迁移与新活动（turn.start/tool.call）
 * 时前进，相位翻转与无 phase 心跳不动它——waiting 会话上它就是「等了多久」。
 *
 * 回填语义（LIVE_WINDOW 之外的历史事件）：
 *   建档会话并按终态事件落档——kimi 正在运行但 10 分钟前已 TurnEnd，
 *   此刻它真实状态就是 waiting（在等你），不能因为"事件旧"就当它不存在。
 *   但旧 turn.start/tool.call 不会置 working——半路没下文的是废弃 turn（进程多半
 *   已死），落 ended 由 grace 期清走，而不是 stale「疑似卡住」吓用户。
 *   旧 permission.request 同样是废弃审批：不落 waiting(approval)、不发通知，落 ended，
 *   避免回放把面板卡在等批准。比本会话已见最新事件更旧的历史事件（乱序回放）不改状态、
 *   不回写 cwd/title/model；live 仍按到达顺序迁移。usage 不论新旧、不论乱序都累加。
 *   旧事件不发 change 通知，避免启动回放刷屏；旧 status 事件不迁移状态。
 *
 * 订阅者经 onChange 收到「快照变化」通知（去抖由调用方做）。
 */

import type { AgentEvent, AgentStatus, SessionSnapshot, TokenUsage, WaitingReason } from '../types';

/** working 无事件超时判 stale 的阈值（ms）。 */
export const STALE_AFTER_MS = 3 * 60_000;
/** ended 会话保留在 Map 里的时长（ms）——只供同 id 复用，不进面板。 */
const ENDED_GRACE_MS = 60_000;
/** 事件「新鲜度」窗口：比这更老的事件按回填语义处理（建档但不算正在工作）。 */
export const LIVE_WINDOW_MS = 90_000;
/** waiting 超过该时长自动降回 idle（用户走了不再算"轮到你"）。 */
const WAITING_DECAY_MS = 30 * 60_000;
/** stale 超过该时长判死：进程大概率已没了，落 ended 收尾。 */
const STALE_GIVEUP_MS = 30 * 60_000;
/** 快照可见窗口：超过 24h 无动静的非 ended 会话从面板剔除。 */
const SESSION_VISIBLE_MS = 24 * 3600 * 1000;

interface SessionState extends SessionSnapshot {
  // statusAt（SessionSnapshot 字段）兼任内部「上次状态迁移时间」，watchdog 依据。
}

function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

export class StatusEngine {
  private sessions = new Map<string, SessionState>();
  private listeners = new Set<() => void>();

  /** 订阅快照变化。 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private key(agent: string, sessionId: string) {
    return `${agent}:${sessionId}`;
  }

  /** 喂入一条事件，驱动状态迁移。 */
  apply(e: AgentEvent) {
    const live = Date.now() - e.at <= LIVE_WINDOW_MS;
    const key = this.key(e.agent, e.sessionId);
    let s = this.sessions.get(key);
    if (!s) {
      // 已结束的未知会话不重建。
      if (e.kind === 'session.end') return;
      s = {
        agent: e.agent,
        sessionId: e.sessionId,
        status: 'idle',
        statusAt: e.at,
        cwd: e.cwd,
        title: e.title,
        model: e.model,
        lastEventAt: e.at,
        startedAt: e.at,
        tokens: emptyTokens(),
        costUsd: 0,
      };
      this.sessions.set(key, s);
    }

    // lastEventAt 取已见最大时间戳（含回放），"x分钟前"不被乱序旧事件拉回去。
    // 比这个水位更旧的历史事件不回写元信息、不迁移状态；live 乱序仍按到达顺序覆盖。
    const seenAt = s.lastEventAt;
    s.lastEventAt = Math.max(s.lastEventAt, e.at);
    const stale = !live && e.at < seenAt;
    if (!stale) {
      if (e.cwd) s.cwd = e.cwd;
      if (e.title) s.title = e.title;
      if (e.model) s.model = e.model;
    }

    const set = (status: AgentStatus, reason?: WaitingReason) => {
      if (s.status !== status || s.waitingReason !== reason) {
        s.status = status;
        s.waitingReason = reason;
        s.statusAt = e.at;
      }
      // 相位与等待对象是状态上下文：离开 working 清相位、离开 waiting 清等待对象；
      // 同为 working 的无 phase 心跳不清相位——粗粒度轮询（zcode tasks）不知道
      // 当前相位，不该把 hook 标好的 tool 相位抹掉。
      if (status !== 'working') s.phase = undefined;
      if (status !== 'waiting') s.waitingDetail = undefined;
    };

    // 乱序历史事件到此为止：token 仍在下面累加，状态与时间线保持已到达的更新值。
    if (!stale) switch (e.kind) {
      case 'session.start':
        if (s.status === 'ended') set('idle');
        break;
      case 'turn.start':
        // 活事件→working(thinking)；旧事件说明 turn 半路没了下文（废弃/进程已死），落 ended。
        // stale 只留给「live working 后突然沉默」的场景——那才真是疑似卡住。
        if (live) {
          set('working');
          s.phase = 'thinking';
        } else set('ended');
        s.turnStartAt = e.at;
        s.statusAt = e.at;
        break;
      case 'tool.call':
        if (live) {
          set('working');
          s.phase = 'tool';
        } else set('ended');
        s.toolCallAt = e.at;
        if (e.detail) s.toolName = e.detail;
        s.statusAt = e.at;
        break;
      case 'permission.request':
        // 活审批→waiting(approval)；旧审批是废弃 turn，落 ended，不冒充当前等待。
        if (live) {
          set('waiting', 'approval');
          s.waitingDetail = e.detail;
        } else set('ended');
        break;
      case 'turn.end':
        set('waiting', e.waitingReason ?? 'turn-end');
        break;
      case 'session.end':
        set('ended');
        break;
      case 'status':
        // live 才迁移；回填 status 只刷活性，也不写相位——相位描述的是"现在"。
        if (live) {
          if (e.status) {
            set(e.status, e.waitingReason);
            if (e.status === 'waiting') s.waitingDetail = e.detail;
          }
          if (e.phase && s.status === 'working') {
            s.phase = e.phase;
            if (e.phase === 'tool' && e.detail) s.toolName = e.detail;
          }
        }
        break;
      case 'usage':
        break;
    }

    if (e.tokens) {
      const t = s.tokens;
      t.input += e.tokens.input;
      t.output += e.tokens.output;
      t.cacheRead = (t.cacheRead ?? 0) + (e.tokens.cacheRead ?? 0);
      t.cacheWrite = (t.cacheWrite ?? 0) + (e.tokens.cacheWrite ?? 0);
      t.reasoning = (t.reasoning ?? 0) + (e.tokens.reasoning ?? 0);
    }

    // 只有活事件才发变更通知；回填沉默建档。
    if (live || e.tokens) this.emit();
  }

  /** watchdog：working 超时判 stale、waiting 衰减、清理过期 ended 与超龄会话。返回是否有变化。 */
  sweep(now = Date.now()): boolean {
    let changed = false;
    for (const [key, s] of this.sessions) {
      if (
        (s.status === 'ended' && now - s.statusAt > ENDED_GRACE_MS) ||
        now - s.lastEventAt > SESSION_VISIBLE_MS
      ) {
        // ended 过 grace 或任何状态超龄（回填建档的死会话）都清除，防 Map 无界增长。
        this.sessions.delete(key);
        changed = true;
      } else if (s.status === 'working' && now - s.lastEventAt > STALE_AFTER_MS) {
        s.status = 'stale';
        s.phase = undefined;
        s.statusAt = now;
        changed = true;
      } else if (s.status === 'stale' && now - s.lastEventAt > STALE_GIVEUP_MS) {
        // stale 沉默 30min：进程多半已死，落 ended 走 grace 清走。
        s.status = 'ended';
        s.statusAt = now;
        changed = true;
      } else if (s.status === 'waiting' && now - s.lastEventAt > WAITING_DECAY_MS) {
        s.status = 'idle';
        s.waitingReason = undefined;
        s.waitingDetail = undefined;
        s.statusAt = now;
        changed = true;
      }
    }
    if (changed) this.emit();
    return changed;
  }

  /**
   * 当前快照（按 lastEventAt 倒序）——面板只出活跃会话：
   * working/waiting/stale 直出；idle 仅限 LIVE_WINDOW 内新建（start→turn.start 过渡）；
   * ended 不进面板（grace 期只留在 Map 供同 id 复活）。
   */
  snapshot(): SessionSnapshot[] {
    const now = Date.now();
    return [...this.sessions.values()]
      .filter((s) => now - s.lastEventAt <= SESSION_VISIBLE_MS)
      .filter((s) => s.status !== 'ended' && (s.status !== 'idle' || now - s.lastEventAt <= LIVE_WINDOW_MS))
      .map((s) => ({ ...s }))
      .sort((a, b) => b.lastEventAt - a.lastEventAt);
  }

  /**
   * grace 期内刚结束的会话（只读副本，按结束时间倒序截 limit）——「最近结束」
   * 折叠组数据源。endedAt≈statusAt（状态迁移时刻）；sweep 清走后自然消失。
   * 与 snapshot() 分工：活跃面不含 ended，这里只出 ended，互不影响聚合态。
   */
  recentlyEnded(limit: number): SessionSnapshot[] {
    const now = Date.now();
    return [...this.sessions.values()]
      .filter((s) => s.status === 'ended' && now - s.statusAt <= ENDED_GRACE_MS)
      .sort((a, b) => b.statusAt - a.statusAt)
      .slice(0, limit)
      .map((s) => ({ ...s, endedAt: s.statusAt }));
  }

  /** 聚合态：working > waiting > stale > idle > ended。allowed 给定时只统计其中的 agent。 */
  overall(allowed?: ReadonlySet<string>): AgentStatus {
    let result: AgentStatus = 'ended';
    const rank: Record<AgentStatus, number> = { working: 4, waiting: 3, stale: 2, idle: 1, ended: 0 };
    for (const s of this.sessions.values()) {
      if (allowed && !allowed.has(s.agent)) continue;
      if (rank[s.status] > rank[result]) result = s.status;
    }
    return result;
  }
}
