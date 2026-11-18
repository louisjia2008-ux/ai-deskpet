import type { JSX } from 'react';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './chat-markdown.css';

const components: Components = {
  // A remote image would load by itself and could carry conversation text out in
  // its URL, so a reply can only show one as a link the user chooses to open.
  img: ({ src, alt }) => typeof src === 'string' ? <a href={src} target="_blank" rel="noreferrer">{alt || src}</a> : <>{alt}</>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
  table: ({ children }) => <div className="chat-markdown-table"><table>{children}</table></div>,
};

/** Model text only. Raw HTML stays inert text and unsafe link protocols are removed. */
export const ChatMarkdown = ({ text, revealing }: { text: string; revealing?: boolean }): JSX.Element =>
  <div className="chat-reply chat-markdown" {...(revealing === undefined ? {} : { 'data-revealing': revealing })}>
    <Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown>
  </div>;
