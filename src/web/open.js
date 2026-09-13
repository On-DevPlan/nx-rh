// 跨平台打开浏览器（零依赖，参考各 npx 面板工具的惯例做法）
import { spawn } from 'node:child_process';

export function openBrowser(url) {
  try {
    const plat = process.platform;
    if (plat === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (plat === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // 打不开就算了，URL 已打印在终端
  }
}
