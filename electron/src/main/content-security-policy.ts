const BASE_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

export const contentSecurityPolicy = (source: string): string => {
  const url = new URL(source);
  if (url.protocol === 'deskpet:' && url.hostname === 'app' && url.pathname === '/main_window/index.html') {
    return BASE_POLICY.replace("img-src 'self' data:", "img-src 'self' data: deskpet://managed/reply-images/");
  }
  const overlay = url.protocol === 'deskpet:' && url.hostname === 'app' && url.pathname === '/overlay_window/index.html';
  if (!overlay) return BASE_POLICY;
  return BASE_POLICY
    .replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval' deskpet://managed/core/live2dcubismcore.min.js")
    .replace("img-src 'self' data:", "img-src 'self' data: deskpet://managed/models/")
    .replace("connect-src 'self'", "connect-src 'self' deskpet://managed/models/")
    .concat('; media-src deskpet://managed/models/');
};
