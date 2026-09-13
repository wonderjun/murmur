/**
 * webview 入口：挂载 Vue + Pinia + 全局样式。
 * Lora variable 只注册 latin 子集（@font-face unicode-range 按需加载），
 * CJK 落到苹方，故不在此打包中文字体。
 */

import { createPinia } from "pinia";
import { createApp } from "vue";

import "@fontsource-variable/lora/wght.css";
import "@fontsource-variable/lora/wght-italic.css";

import App from "./App.vue";
import "./app.css";

createApp(App).use(createPinia()).mount("#app");
