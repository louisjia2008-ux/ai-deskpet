import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './content-security-policy';

describe('Live2D content security policy', () => {
  it('allows only the validated Core and model assets in the overlay document', () => {
    const policy = contentSecurityPolicy('deskpet://app/overlay_window/index.html');
    const directives = Object.fromEntries(policy.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }));
    expect(directives['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'", 'deskpet://managed/core/live2dcubismcore.min.js']);
    expect(directives['connect-src']).toEqual(["'self'", 'deskpet://managed/models/']);
    expect(directives['img-src']).toContain('deskpet://managed/models/');
    expect(directives['script-src']).not.toContain("'unsafe-eval'");
    expect(directives['script-src']).not.toContain('deskpet://managed/models/');
    expect(policy).not.toMatch(/https?:|\*/);
  });

  it('does not grant Live2D permissions to the console, managed content or other origins', () => {
    for (const source of ['deskpet://managed/models/model/a.model3.json', 'https://app/overlay_window/index.html']) {
      const policy = contentSecurityPolicy(source);
      expect(policy).toContain("script-src 'self';");
      expect(policy).not.toContain('deskpet://managed');
      expect(policy).not.toContain('wasm-unsafe-eval');
    }
  });

  it('allows managed reply images in the console without granting model, script or network access', () => {
    const policy = contentSecurityPolicy('deskpet://app/main_window/index.html');
    expect(policy).toContain("img-src 'self' data: deskpet://managed/reply-images/;");
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("connect-src 'self';");
    expect(policy).not.toContain('deskpet://managed/models/');
    expect(policy).not.toMatch(/https?:|\*|wasm-unsafe-eval/u);
  });
});
