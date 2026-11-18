import { describe, expect, it } from 'vitest';
import { readableHtml, webToolContent } from './web-content';

describe('web tool readable content', () => {
  const html = '<!doctype html><title>Title &amp; facts</title><style>body { color:red }</style><script>steal()</script><main><h1>Heading &lt;1&gt;</h1><p>Before <b>bold</b> after.</p><a href="../guide?q=1&amp;x=2">Read guide</a><img alt="Diagram description"><table><tr><th>A</th><th>B</th></tr><tr><td>12</td><td>34</td></tr></table><pre>if (ok) {\n  print("a  b");\n}</pre><script type="application/ld+json">{"price":29}</script></main><footer>Source note</footer>';
  it('preserves factual text, headings, decoded entities, links, tables, code and structured data', () => {
    const text = readableHtml(html, 'https://example.com/docs/page');
    for (const expected of ['Title: Title & facts', '# Heading <1>', 'Before bold after.', 'Read guide (https://example.com/guide?q=1&x=2)', 'Diagram description', 'A\tB', '12\t34', 'if (ok) {\n  print("a  b");\n}', '{"price":29}', 'Source note']) expect(text).toContain(expected);
    expect(text).not.toContain('steal'); expect(text).not.toContain('color:red');
  });
  it('keeps raw HTML available and leaves plain text and JSON untouched', () => {
    const response = { url: 'https://example.com', contentType: 'text/html', text: html };
    expect(webToolContent(response).text).toBe(readableHtml(html, response.url));
    expect(webToolContent(response, 'html').text).toBe(html);
    for (const contentType of ['text/plain', 'application/json']) expect(webToolContent({ ...response, contentType }).text).toBe(html);
  });
  it('rejects a page with no extracted text while retaining explicitly requested raw HTML', () => {
    const response = { url: 'https://example.com', contentType: 'text/html', text: '<html><script>PRIVATE_SCRIPT</script><style>body{color:red}</style></html>' };
    expect(() => webToolContent(response)).toThrow(expect.objectContaining({ code: 'tool.network', detail: 'web.emptyContent' }));
    expect(webToolContent(response, 'html').text).toBe(response.text);
  });
  it('resolves links using the document base URL', () => {
    expect(readableHtml('<base href="/guide/"><a href="intro">Intro</a>', 'https://example.com/page')).toContain('https://example.com/guide/intro');
  });
  it('preserves significant whitespace inside preformatted code', () => {
    const code = 'text = """a  \n\n\n  b"""';
    expect(readableHtml(`<pre>${code}</pre>`, 'https://example.com')).toContain(code);
  });
  it('handles malformed and deeply nested input without executing links or dropping their labels', () => {
    const text = readableHtml('<div>'.repeat(2_000) + '<a href="javascript:alert(1)">Label</a><p>Last', 'https://example.com');
    expect(text).toContain('Label'); expect(text).toContain('Last'); expect(text).not.toContain('javascript:');
  });
});
