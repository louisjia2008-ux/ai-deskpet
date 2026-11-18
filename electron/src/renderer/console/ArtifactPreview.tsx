import { lazy, Suspense, useMemo } from 'react';
import type { JSX } from 'react';
import type { ChatArtifactPreview } from '../../shared/chat-work';
import { ChatMarkdown } from './ChatMarkdown';
import { parseArtifactCsv } from './artifact-csv';
import './artifacts.css';

const PdfPreview = lazy(async () => { const module = await import('./ArtifactPdfPreview'); return { default: module.ArtifactPdfPreview }; });

export const ArtifactPreview = ({ preview, zh }: { preview: ChatArtifactPreview; zh: boolean }): JSX.Element => {
  const csv = useMemo(() => { if (preview.kind !== 'csv') return null; try { return parseArtifactCsv(preview.text); } catch { return null; } }, [preview]);
  return <div className="artifact-preview" aria-label={zh ? '成果预览' : 'Artifact preview'}>
    {preview.kind === 'markdown' && <ChatMarkdown text={preview.text} />}
    {preview.kind === 'text' && <pre>{preview.text}</pre>}
    {preview.kind === 'pdf' && <Suspense fallback={<p role="status">{zh ? '正在加载 PDF 预览…' : 'Loading PDF preview…'}</p>}><PdfPreview dataBase64={preview.dataBase64} zh={zh} /></Suspense>}
    {preview.kind === 'csv' && (csv ? <><div className="artifact-table"><table><thead><tr>{csv.rows[0]?.map((cell, index) => <th key={index} scope="col">{cell || '—'}</th>)}</tr></thead><tbody>{csv.rows.slice(1).map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div>{csv.truncated && <p role="note">{zh ? '表格预览已截取：最多 200 行数据、50 列，每格 4,000 字符。原文件完整保留。' : 'Preview is limited to 200 data rows, 50 columns and 4,000 characters per cell. The original file is unchanged.'}</p>}</> : <p role="alert">{zh ? 'CSV 格式无法解析，可在文件夹中查看原文件。' : 'The CSV could not be parsed. Reveal the original file in its folder.'}</p>)}
    {preview.kind === 'unsupported' && <p>{zh ? '此文件类型暂不支持内嵌预览，可在文件夹中查看。' : 'This file type has no inline preview. Reveal it in its folder.'}</p>}
  </div>;
};
