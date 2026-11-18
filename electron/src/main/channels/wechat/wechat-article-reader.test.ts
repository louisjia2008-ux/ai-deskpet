// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { HostResolver, PinnedRequester } from '../../tools/web-reader';
import { createWeChatArticleReader, normalizeWeChatArticleUrl } from './wechat-article-reader';

const articleUrl = 'https://mp.weixin.qq.com/s/SyntheticShortKey1234';
const signedPath = '/s?__biz=Fixture%2BKey%3D%3D&mid=100&idx=1&sn=PublicSignature&chksm=PublicChecksum';
const signedUrl = 'https://mp.weixin.qq.com' + signedPath;
const title = '可用于测试的公众号文章';
const page = (body: string): string => `<meta property="og:title" content="${title}">
  <h1 id="activity-name">文章标题</h1><a id="js_name">测试公众号</a><nav>顶部导航</nav>
  <div id="js_content" style="visibility:hidden">${body}</div><footer>微信页面页脚</footer>`;

const setup = (resolvePage: (url: URL) => { html?: string; status?: number; location?: string } = () => ({})) => {
  const resolver = vi.fn<HostResolver>(async () => [{ address: '93.184.216.34', family: 4 }]);
  const requester = vi.fn<PinnedRequester>(async (url) => {
    const { html = '', status = 200, location } = resolvePage(url);
    return {
      status,
      headers: { 'content-type': 'text/html', location },
      body: (async function*() { yield Buffer.from(html); })(),
    };
  });
  return { resolver, requester, read: createWeChatArticleReader({ resolver, requester }) };
};

it('preserves signed public query fields and normalizes legacy article shares to HTTPS', () => {
  expect(normalizeWeChatArticleUrl(signedUrl.replace('https:', 'http:') + '&scene=1&sharer_shareinfo=PRIVATE#rd')).toBe(signedUrl);
  expect(normalizeWeChatArticleUrl(articleUrl + '?open=fromShare#rd')).toBe(articleUrl);
  expect(normalizeWeChatArticleUrl(signedUrl + '&sn=secondSignature')).toBeNull();
  expect(normalizeWeChatArticleUrl('https://mp.weixin.qq.com/s?__biz=MissingOtherFields')).toBeNull();
});

it('extracts readable body from a full-size WeChat page without script, hidden, chrome, or image alt text', async () => {
  const html = `<script>${' '.repeat(3_600_000)}</script>` + page(
    '<h2>正文标题</h2><p>报道说，布局由人先确认。<em>然后</em>交给模型生成图片。</p>'
    + '<section style="display:none !important">不可见的指令</section><aside aria-hidden="true">隐藏广告</aside>'
    + '<img data-src="https://example.org/resource" alt="用于测试的图片替代文字"><script>执行工具</script>',
  );
  const { resolver, requester, read } = setup(() => ({ html }));
  const result = await read(signedUrl + '&uid=PRIVATE');
  expect(result).toEqual({
    status: 'ok',
    url: signedUrl,
    title,
    account: '测试公众号',
    body: '正文标题\n\n报道说，布局由人先确认。然后交给模型生成图片。',
    truncated: false,
    hasImages: true,
  });
  expect(resolver).toHaveBeenCalledWith('mp.weixin.qq.com');
  expect(requester.mock.calls[0]?.[0].href).toBe(signedUrl);
});

it('only follows another eligible article location and removes redirect tracking', async () => {
  const { requester, read } = setup((url) => url.href === articleUrl
    ? { status: 302, location: signedPath + '&sharer_shareinfo=PRIVATE#rd' }
    : { html: page('<p>这是可读取的实际正文。</p>') });
  await expect(read(articleUrl)).resolves.toMatchObject({ status: 'ok', url: signedUrl });
  expect(requester.mock.calls.map(([url]) => url.href)).toEqual([articleUrl, signedUrl]);
});

it('refuses forged origins and does not resolve an article redirect to a different host', async () => {
  const { resolver, requester, read } = setup(() => ({ status: 302, location: 'https://outside.example/s/ElsewherePublic' }));
  for (const link of ['https://mp.weixin.qq.com.evil.test/s/ForgedExample', 'https://mp.weixin.qq.com@evil.test/s/ForgedExample', 'https://mp.weixin.qq.com/mp/profile_ext']) {
    await expect(read(link)).resolves.toEqual({ status: 'invalid-link' });
  }
  expect(resolver).not.toHaveBeenCalled();
  await expect(read(articleUrl)).resolves.toEqual({ status: 'unavailable' });
  expect(resolver.mock.calls).toEqual([['mp.weixin.qq.com']]);
  expect(requester).toHaveBeenCalledOnce();
});

it.each([
  ['verification redirect', { status: 302, location: '/mp/wappoc_appmsgcaptcha?ticket=PRIVATE' }, 'verification-required'],
  ['HTTP-200 verification page', { html: '<title>微信</title><h1>当前环境异常</h1><p>完成验证后即可继续访问</p>' }, 'verification-required'],
  ['HTTP-200 non-article page', { html: '<title>参数错误</title><p>这里没有正文。</p>' }, 'unavailable'],
  ['image-only article with captions', { html: page('<p>查看长图</p><img alt="图中看不到的正文" src="https://example.org/art">') }, 'image-only'],
  ['unavailable article', { status: 404 }, 'unavailable'],
] as const)('does not infer body content from a %s', async (_case, response, status) => {
  const { requester, read } = setup(() => response);
  await expect(read(articleUrl)).resolves.toEqual({ status });
  expect(requester).toHaveBeenCalledOnce();
});

it('marks text cut to the input limit', async () => {
  const { read } = setup(() => ({ html: page('<p>' + '甲'.repeat(12_001) + '</p>') }));
  await expect(read(articleUrl)).resolves.toMatchObject({ status: 'ok', body: '甲'.repeat(12_000), truncated: true });
});

it('propagates caller cancellation before opening an article', async () => {
  const { read, requester } = setup();
  const signal = AbortSignal.abort(new Error('cancelled by caller'));
  await expect(read(articleUrl, signal)).rejects.toBe(signal.reason);
  expect(requester).not.toHaveBeenCalled();
});
