/**
 * 天光（Dawn）：面板顶部左侧的琥珀环境光晕，「暮色栖木」签名氛围层。
 * 纯装饰（aria-hidden + pointer-events-none），盖在背景上、内容之下。
 * quiet 档是恒亮静默光；live 档（有 waiting 会话时）光强更高并配
 * animate-dawn 慢呼吸——与天光语义一致：琥珀亮起 = 轮到你了。
 * 两档强度由 app.css 的 dawn-quiet / dawn-live utility 承载（color-mix
 * 百分比不能吃 CSS 变量，故强度固化在 utility 里）。
 */

import { cn } from "@/lib/utils";

/** 琥珀天光层；live 时切换到 live 档强度并呼吸。 */
export default function Dawn({ live = false, className }: { live?: boolean; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      <div className={cn("absolute inset-0", live ? "dawn-live animate-dawn" : "dawn-quiet")} />
    </div>
  );
}
