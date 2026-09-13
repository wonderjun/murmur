/**
 * 样式工具：clsx + tailwind-merge 的 cn()，shadcn-vue 惯例。
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
