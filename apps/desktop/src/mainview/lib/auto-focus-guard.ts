/**
 * 初焦点守卫：WKWebView 窗口首次变 key（初响应者就位）时会把焦点落进 DOM
 * 靠前的可聚焦元素——首开面板「轮到你了」hero 卡吃到 macOS 系统蓝焦点环
 * （此刻页面内没有任何用户事件，WebKit 把它当键盘语境画出 :focus-visible）。
 * 文档级监听 focusin：距最近一次用户事件（pointerdown/keydown）超过宽限窗且
 * 目标非文本输入类的焦点一律 blur——初焦点不是用户意图；键盘 Tab/方向键与
 * 点击聚焦都紧跟用户事件，照常放行。幂等：StrictMode 双挂载只装一份。
 */

const USER_EVENT_GRACE_MS = 100;

let installed = false;

/** 安装初焦点守卫（每个 webview 文档一份），重复调用忽略。 */
export function installAutoFocusGuard(): void {
  if (installed) return;
  installed = true;

  let lastUserEventAt = 0;
  for (const type of ["pointerdown", "keydown"] as const) {
    document.addEventListener(type, () => (lastUserEventAt = performance.now()), { capture: true, passive: true });
  }

  document.addEventListener(
    "focusin",
    (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      // 文本输入类是合法的自动聚焦目标（搜索框/表单），不抢
      if (target.isContentEditable || target.matches("input, textarea, select")) return;
      if (performance.now() - lastUserEventAt < USER_EVENT_GRACE_MS) return;
      // 初焦点非用户意图：还给 body，首开面板不带聚焦态
      target.blur();
    },
    { capture: true },
  );
}
