import pluginJs from "@eslint/js";
import pluginBetterTailwindcss from "eslint-plugin-better-tailwindcss";
import pluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import pluginReactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

// ============================================================================
// ui-design 契约禁区（.agent/skill/ui-design「纪律」节的 lint 落地）：
// 裸色板/任意 hex/dark: 变体/任意 px 字号/非 shadow-float 具名阴影。
// mid:/tight: 窄窗变体仅管理台组件可用（面板恒 392px 会误命中），白名单外的
// 文件在下方独立 block 追加该条。
// ============================================================================
const DESIGN_RESTRICTED = [
  {
    // Tailwind 原生色板裸用（含变体前缀与 /opacity 后缀）：中性走 foreground/
    // muted-foreground/faint，状态走 working/waiting/idle/stale/ended token
    pattern:
      "/^(?:[^:\\s]+:)*(bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d+$/",
    message: "裸 Tailwind 色板禁用——中性色走 foreground/muted-foreground/faint，状态色走 status token",
  },
  {
    pattern: "/\\[#[0-9a-fA-F]{3,8}\\]/",
    message: "任意 hex 禁用——颜色一律走 app.css 语义 token",
  },
  {
    pattern: "/^dark:/",
    message: "dark: 变体禁用——主题差异只走 app.css :root[data-theme] token 块",
  },
  {
    pattern: "/^(?:[^:\\s]+:)*text-\\[\\d+(\\.\\d+)?px\\]$/",
    message: "任意 px 字号禁用——走字阶七档 micro/meta/detail/body/title/headline/display",
  },
  {
    pattern: "/^(?:[^:\\s]+:)*shadow-(xs|sm|md|lg|xl|2xl|inner)$/",
    message: "实体卡阴影退场——阴影只给浮层 shadow-float",
  },
];

// mid:/tight: 白名单（管理台窄窗断点的合法宿主）；新增管理台组件确需窄窗断点
// 时才追加到 ignores，面板共用件永不进此表。
const MANAGER_NARROW_FILES = [
  "src/mainview/components/manager-app.tsx",
  "src/mainview/components/manager-sidebar.tsx",
  "src/mainview/components/page-head.tsx",
];

const TAILWIND_SETTINGS = {
  // v4 CSS-first：app.css 的 @theme/@utility 是自定义 token 唯一真源。
  // rootFontSize 必须显式给——缺省时 px 任意值无法折算 spacing 刻度，
  // gap-[3px]→gap-0.75 这类 canonical 归一会被静默跳过。
  "better-tailwindcss": { entryPoint: "src/mainview/app.css", rootFontSize: 16 },
};

export default [
  // 全局忽略：构建产物与 hutch devkit
  {
    ignores: [
      "dist/**",
      "build/**",
      "artifacts/**",
      "node_modules/**",
      ".hutch/**",
      ".cottontail-tmp/**",
      "icon.iconset/**",
      "icons/**",
    ],
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_` 前缀是有意忽略的参数/变量约定
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  // globals 分面：webview 走 browser；bun 主进程/测试/根配置走 node + Bun
  {
    files: ["src/mainview/**/*.{ts,tsx}", "src/shared/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["src/bun/**/*.ts", "test/**/*.ts", "*.{ts,js,mts,cts}"],
    languageOptions: {
      globals: { ...globals.node, Bun: "readonly", BunWebView: "readonly" },
    },
  },
  // React hooks 经典两条：v7 recommended-latest 的 compiler 系规则（purity/
  // immutability 等）对存量面板代码噪音过大，先守契约型规则
  {
    files: ["src/mainview/**/*.{ts,tsx}"],
    plugins: { "react-hooks": pluginReactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // ==========================================================================
  // Tailwind class 规范（better-tailwindcss，v4 entryPoint 读 app.css token）
  // enforce-canonical-classes 与编辑器 suggestCanonicalClasses 同源同义。
  // 不开 enforce-consistent-class-order：全仓 class 重排 diff 噪音过大。
  // ==========================================================================
  {
    files: ["src/mainview/**/*.{ts,tsx}"],
    plugins: { "better-tailwindcss": pluginBetterTailwindcss },
    settings: TAILWIND_SETTINGS,
    rules: {
      "better-tailwindcss/enforce-canonical-classes": "error",
      "better-tailwindcss/no-unnecessary-whitespace": "error",
      "better-tailwindcss/no-duplicate-classes": "error",
      "better-tailwindcss/no-conflicting-classes": "error",
      "better-tailwindcss/no-deprecated-classes": "error",
      "better-tailwindcss/no-restricted-classes": ["error", { restrict: DESIGN_RESTRICTED }],
    },
  },
  // mid:/tight: 在管理台白名单外禁用（restrict 整表覆盖，需带上全部禁区）
  {
    files: ["src/mainview/**/*.{ts,tsx}"],
    ignores: MANAGER_NARROW_FILES,
    plugins: { "better-tailwindcss": pluginBetterTailwindcss },
    settings: TAILWIND_SETTINGS,
    rules: {
      "better-tailwindcss/no-restricted-classes": [
        "error",
        {
          restrict: [
            ...DESIGN_RESTRICTED,
            {
              pattern: "/^(?:mid|tight):/",
              message: "mid:/tight: 窄窗变体仅管理台组件可用——面板恒 392px 会误命中",
            },
          ],
        },
      ],
    },
  },
  // webview 桥边界：与 architecture-boundary.test.ts 同口径（lib/rpc.ts 是唯一触点），
  // 此处提供编辑器即时反馈；test:desktop 的扫描仍是最终门禁。
  {
    files: ["src/mainview/**/*.{ts,tsx}"],
    ignores: ["src/mainview/lib/rpc.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["electrobun", "electrobun/*"],
              message: "webview 禁止直接 import electrobun——一律经 @/lib/rpc.ts 的 useRpc 单例",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.type='Identifier'][object.name='window'][property.name='electrobun']",
          message: "window.electrobun 只允许在 lib/rpc.ts 访问",
        },
      ],
    },
  },
  // RPC 契约文件：`{ params: {} }` 是 electrobun RPC 的「无参数」契约形状，
  // 改成 object/Record 会改变双端契约语义——豁免 no-empty-object-type。
  {
    files: ["src/shared/rpc.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
  // registry 复制式组件库（shadcn，落库即项目代码但保持上游形态）：存量类型告警降级
  {
    files: ["src/mainview/components/ui/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-undef": "off",
    },
  },
  // prettier 收尾：prettier/prettier 报 error，eslint-config-prettier 关冲突规则
  pluginPrettierRecommended,
];
