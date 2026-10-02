/**
 * 品牌图：@lobehub/icons 的 glyph + 官方 style.js 的 Avatar 常量
 * （底色/glyph 色/图标占比）自拼方砖——渲染等价官方 Avatar 组件，但不把
 * @lobehub/ui/antd-style 整条链拖进 bundle。
 * 字形变体须逐品牌镜像官方 Avatar 的选择：自变色品牌（kimi/qoder/devin/codex）
 * 官方挂 Color/Inner 而非 Mono——Mono 是 currentColor 实心形，codex/devin 的
 * AVATAR_* 在 5.x 全是 #fff，套上去就是白底白字形直接隐身。
 * agent→组件静态映射保证 tree-shake；无映射的新 agent 落 muted 缩写占位。
 */

import { Codex, Cursor, Devin, Kimi, OpenCode, Qoder, ZAI } from "@lobehub/icons";
import * as codexStyle from "@lobehub/icons/es/Codex/style";
import * as cursorStyle from "@lobehub/icons/es/Cursor/style";
import * as devinStyle from "@lobehub/icons/es/Devin/style";
import * as kimiStyle from "@lobehub/icons/es/Kimi/style";
import * as opencodeStyle from "@lobehub/icons/es/OpenCode/style";
import * as qoderStyle from "@lobehub/icons/es/Qoder/style";
import * as zaiStyle from "@lobehub/icons/es/ZAI/style";

import { AGENT_META } from "@/lib/agent-meta";

import type { IconType } from "@lobehub/icons";
import type { AgentId } from "@core/types";

/** 品牌方砖渲染参数（值取自官方 style.js，属品牌资产而非 UI 色板）。 */
interface BrandDef {
  Icon: IconType;
  bg: string;
  fg: string;
  mult: number;
}

/** agent → lobehub 品牌参数；zcode 取 Z.AI 品牌砖；缺映射落缩写占位。 */
const ICON: Partial<Record<AgentId, BrandDef>> = {
  kimi: { Icon: Kimi.Color, bg: kimiStyle.AVATAR_BACKGROUND, fg: kimiStyle.AVATAR_COLOR, mult: kimiStyle.AVATAR_ICON_MULTIPLE },
  zcode: { Icon: ZAI, bg: zaiStyle.AVATAR_BACKGROUND, fg: zaiStyle.AVATAR_COLOR, mult: zaiStyle.AVATAR_ICON_MULTIPLE },
  opencode: {
    Icon: OpenCode,
    bg: opencodeStyle.AVATAR_BACKGROUND,
    fg: opencodeStyle.AVATAR_COLOR,
    mult: opencodeStyle.AVATAR_ICON_MULTIPLE,
  },
  codex: {
    Icon: Codex.Color,
    bg: codexStyle.AVATAR_BACKGROUND,
    fg: codexStyle.AVATAR_COLOR,
    mult: codexStyle.AVATAR_ICON_MULTIPLE,
  },
  cursor: {
    Icon: Cursor,
    bg: cursorStyle.AVATAR_BACKGROUND,
    fg: cursorStyle.AVATAR_COLOR,
    mult: cursorStyle.AVATAR_ICON_MULTIPLE,
  },
  devin: { Icon: Devin.Color, bg: devinStyle.AVATAR_BACKGROUND, fg: devinStyle.AVATAR_COLOR, mult: devinStyle.AVATAR_ICON_MULTIPLE },
  qoder: { Icon: Qoder.Color, bg: qoderStyle.AVATAR_BACKGROUND, fg: qoderStyle.AVATAR_COLOR, mult: qoderStyle.AVATAR_ICON_MULTIPLE },
};

export default function BrandIcon({ agent, size = 24 }: { agent: AgentId; size?: number }) {
  const def = ICON[agent];
  if (!def) {
    return (
      <span
        className="flex h-full w-full items-center justify-center bg-muted font-mono font-medium text-muted-foreground"
        style={{ fontSize: Math.round(size * 0.44) }}
      >
        {AGENT_META[agent].abbr}
      </span>
    );
  }
  return (
    <span
      className="flex h-full w-full items-center justify-center"
      style={{ background: def.bg, boxShadow: "inset 0 0 0 1px var(--hairline)" }}
    >
      <def.Icon size={Math.round(size * def.mult)} color={def.fg} />
    </span>
  );
}
