import { execFile } from 'node:child_process';

/** Window geometry only: no titles, pixels, app names or keystrokes are returned or stored. */
export async function foregroundCoversDisplay(bounds: readonly { x: number; y: number; width: number; height: number }[]): Promise<boolean> {
  if (process.platform !== 'darwin') return true; // unknown is not permission to interrupt
  const program = `ObjC.import('Cocoa'); ObjC.import('CoreGraphics');
    const pid = $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)));
    const displays = ${JSON.stringify(bounds)};
    String(windows.some(w => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && displays.some(d =>
      Math.abs(w.kCGWindowBounds.X-d.x)<3 && Math.abs(w.kCGWindowBounds.Y-d.y)<3 &&
      w.kCGWindowBounds.Width>=d.width-3 && w.kCGWindowBounds.Height>=d.height-3)));`;
  return new Promise((resolve, reject) => execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', program], { timeout: 3000, maxBuffer: 1024 }, (error, stdout) => {
    if (error || !/^(true|false)\s*$/u.test(stdout)) reject(new Error('proactive.screenUnknown')); else resolve(stdout.trim() === 'true');
  }));
}
