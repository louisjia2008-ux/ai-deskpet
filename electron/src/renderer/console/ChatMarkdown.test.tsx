import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ChatMarkdown } from './ChatMarkdown';

afterEach(cleanup);

it('renders emphasis, lists, tables and code instead of showing their markers', () => {
  const { container } = render(<ChatMarkdown text={'**重点**\n\n- 第一项\n\n| 工具 | 价格 |\n|---|---|\n| 文档 | ¥90 |\n\n```\nnpm test\n```'} />);
  expect(container.querySelector('strong')?.textContent).toBe('重点');
  expect(container.querySelector('li')?.textContent).toBe('第一项');
  expect(screen.getByRole('table').textContent).toContain('¥90');
  expect(container.querySelector('pre code')?.textContent).toContain('npm test');
  expect(container.textContent).not.toContain('**');
});

it('keeps raw HTML inert and never loads a remote image', () => {
  const { container } = render(<ChatMarkdown text={'<img src="https://example.org/leak?data=secret"> <script>alert(1)</script>\n\n![photo](https://example.org/leak?data=secret)'} />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
  expect(screen.getByRole('link', { name: 'photo' }).getAttribute('href')).toBe('https://example.org/leak?data=secret');
});

it('removes unsafe link protocols and opens web links outside the app window', () => {
  const { container } = render(<ChatMarkdown text={'[bad](javascript:alert(1)) [good](https://example.org/)'} />);
  const links = [...container.querySelectorAll('a')];
  expect(links.find((link) => link.textContent === 'bad')?.getAttribute('href') ?? '').not.toContain('javascript');
  expect(links.find((link) => link.textContent === 'good')).toMatchObject({ target: '_blank' });
});
