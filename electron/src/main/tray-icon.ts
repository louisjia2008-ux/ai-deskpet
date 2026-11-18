import { nativeImage } from 'electron';
import type { NativeImage } from 'electron';

import { TRAY_COLOR_1X, TRAY_COLOR_2X, TRAY_TEMPLATE_1X, TRAY_TEMPLATE_2X } from './tray-icon-data';

/** Native tray images must be PNG/JPEG; SVG data URLs decode to empty images. */
export function createTrayIcon(): NativeImage {
  const template = process.platform === 'darwin';
  const image = nativeImage.createFromBuffer(Buffer.from(template ? TRAY_TEMPLATE_1X : TRAY_COLOR_1X, 'base64'), { scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(template ? TRAY_TEMPLATE_2X : TRAY_COLOR_2X, 'base64') });
  image.setTemplateImage(template);
  return image;
}
