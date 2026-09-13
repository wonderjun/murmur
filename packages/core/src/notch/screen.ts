/**
 * 主屏尺寸探测：经 JXA 拿 NSScreen.mainScreen.frame（AppKit 坐标，原点左下）。
 * 刘海条定位用；失败返回 null 由调用方兜底。
 */

import { execFileSync } from 'node:child_process';

export interface ScreenFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function mainScreenFrame(): ScreenFrame | null {
  try {
    const out = execFileSync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var f=$.NSScreen.mainScreen.frame; JSON.stringify({x:f.origin.x,y:f.origin.y,w:f.size.width,h:f.size.height})'],
      { timeout: 3000, encoding: 'utf8' },
    ).trim();
    const d = JSON.parse(out) as ScreenFrame;
    return d && d.w > 0 ? d : null;
  } catch {
    return null;
  }
}
