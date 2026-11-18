import { createHash, randomUUID } from 'node:crypto';
import type { ImportPreview, ImportedMessage } from '../../shared/conversation-import';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (...values: unknown[]): string => values.find((value) => typeof value === 'string' && value.trim()) as string ?? '';
const sourceIdentifier = (...values: unknown[]): string => string(...values.map((value) => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value));
const mediaPlaceholder = /^\[(?:图片|视频|语音|动画表情|表情|文件|红包|转账|Image|Video|Voice|Sticker)\]$/iu;

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const transcriptDigest = (messages: ImportedMessage[]): string => digest(messages.map(({ speakerId, text, time }) => ({ speakerId, text, time })));
export const importedSourceCollectionId = (messages: ImportedMessage[]): string => messages[0]?.sourceCollectionId ?? transcriptDigest(messages);

/** No model supplied ID participates in this identity. With no native event key,
 * identity is limited to the canonical original transcript and its row position:
 * equal text at two different positions remains two independent events. */
export const importedMessageSourceEventId = (messages: ImportedMessage[], index: number): string => {
  const message = messages[index];
  if (!message) throw new Error('imports.invalidResult');
  return message.sourceEventId ?? digest(['import-transcript-event-v1',
    transcriptDigest(messages), index]);
};
export const importedSpeakerEntityId = (messages: ImportedMessage[], speakerId: string): string =>
  messages.find((message) => message.speakerId === speakerId)?.sourceEntityId
    ?? digest(['import-transcript-speaker-v1', transcriptDigest(messages), speakerId]);

const csvRows = (text: string): string[][] => {
  const rows: string[][] = []; let row: string[] = []; let value = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (char === ',' || char === '\n')) { row.push(value); value = ''; if (char === '\n') { rows.push(row); row = []; } }
    else value += char;
  }
  if (quoted) throw new Error('imports.invalid');
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
};

export const parseConversationImport = (name: string, raw: string): ImportPreview => {
  if (Buffer.byteLength(raw, 'utf8') > 2_000_000) throw new Error('imports.tooLarge');
  const text = raw.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim();
  if (!text || text.includes('\0') || text.includes('\uFFFD')) throw new Error('imports.invalid');
  const messages: ImportedMessage[] = []; const nativeSources = new Map<number, string>(); const nativeEntities = new Map<number, string>(); let skipped = 0; let format = 'TXT';
  const add = (speakerId: string, speaker: string, content: string, time: unknown = null, nativeSource?: string, nativeEntity?: string): void => {
    const value = content.trim();
    if (!value || mediaPlaceholder.test(value)) { skipped++; return; }
    if (!speakerId.trim() || !speaker.trim() || speakerId.length > 128 || speaker.length > 128 || value.length > 16_000) throw new Error('imports.invalid');
    messages.push({ id: randomUUID(), speakerId: speakerId.trim(), speaker: speaker.trim(), text: value, time: typeof time === 'number' || typeof time === 'string' ? String(time).slice(0, 80) : null });
    if (nativeSource) nativeSources.set(messages.length - 1, nativeSource);
    if (nativeEntity) nativeEntities.set(messages.length - 1, nativeEntity);
  };
  if (name.toLowerCase().endsWith('.csv')) {
    format = 'CSV'; const rows = csvRows(text); const headers = rows.shift()?.map((header) => header.trim().toLowerCase()) ?? [];
    const column = (keys: string[]): number => headers.findIndex((key) => keys.includes(key));
    const sender = column(['sender', 'speaker', 'name', 'nickname', 'sendername', '发送者', '昵称', '发送人']);
    const content = column(['content', 'text', 'message', 'strcontent', '内容', '消息内容']);
    const time = column(['timestamp', 'time', 'createtime', '时间', '发送时间']);
    if (sender < 0 || content < 0) throw new Error('imports.invalid');
    for (const row of rows) { if (row.every((value) => !value.trim())) continue; add(row[sender] ?? '', row[sender] ?? '', row[content] ?? '', row[time]); }
  } else if (name.toLowerCase().endsWith('.jsonl') || /^[{[]/u.test(text)) {
    let data: unknown;
    try {
      if (name.toLowerCase().endsWith('.jsonl')) {
        const rows = text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#')).map((line) => record(JSON.parse(line)));
        if (rows[0]?._type !== 'header') throw new Error('Invalid header');
        data = { ...rows[0], members: rows.filter((row) => row._type === 'member'), messages: rows.filter((row) => row._type === 'message') };
      } else data = JSON.parse(text) as unknown;
    } catch { throw new Error('imports.invalid'); }
    const root = record(data); const chatlab = root.chatlab !== undefined; format = chatlab ? 'ChatLab JSON' : 'JSON';
    const platform = string(record(root.chatlab).platform, root.platform);
    const conversation = sourceIdentifier(root.conversationId, root.chatId, root.chatroomId, root.talker, record(root.meta).conversationId);
    const members = Array.isArray(root.members) ? root.members.map(record) : [];
    const rows = Array.isArray(data) ? data : root.messages;
    if (!Array.isArray(rows)) throw new Error('imports.invalid');
    for (const rawRow of rows) {
      const row = record(rawRow);
      if ((chatlab && row.type !== 0) || (row.localType !== undefined && row.localType !== 1)) { skipped++; continue; }
      const speakerId = string(row.sender, row.senderUsername, row.speaker, row.name, row.role);
      const member = members.find((item) => item.platformId === speakerId);
      const speaker = string(row.groupNickname, row.accountName, row.senderName, member?.groupNickname, member?.accountName, row.speaker, row.name, speakerId);
      const content = string(row.content, row.text, row.parsedContent);
      if (typeof row.content !== 'string' && !content) { skipped++; continue; }
      const nativeId = sourceIdentifier(row.msgSvrId, row.serverId, row.messageId, row.msgId, row.id);
      // Native IDs need an export namespace. Without it, fall back to the whole
      // original transcript rather than conflating independent copied exports.
      const nativeSource = nativeId && conversation ? digest(['import-native-event-v1', platform, conversation, speakerId || speaker, nativeId]) : undefined;
      const nativeEntity = conversation ? digest(['import-native-speaker-v1', platform, conversation, speakerId || speaker]) : undefined;
      add(speakerId || speaker, speaker, content, row.timestamp ?? row.createTime ?? row.time, nativeSource, nativeEntity);
    }
  } else {
    if (/^\s*<(?:!doctype|html|script)/iu.test(text)) throw new Error('imports.unsupportedHtml');
    let current: { speaker: string; time: string | null; parts: string[] } | null = null;
    const flush = (): void => { if (current) add(current.speaker, current.speaker, current.parts.join('\n'), current.time); };
    // WeChat-style text exports: timestamp + sender on one line, followed by
    // multiline content; also accepts copied "Name: message" transcripts.
    const date = '\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}[ T]\\d{1,2}:\\d{2}(?::\\d{2})?';
    const timestamped = text.split('\n').some((line) => new RegExp(`^(?:\\[?${date}\\]?\\s+.{1,128}|.{1,128}?\\s+\\[?${date}\\]?)\\s*$`, 'u').test(line));
    for (const line of text.split('\n')) {
      const before = line.match(new RegExp(`^\\[?(${date})\\]?\\s+(.{1,128}?)\\s*$`, 'u'));
      const after = line.match(new RegExp(`^(.{1,128}?)\\s+\\[?(${date})\\]?\\s*$`, 'u'));
      const inline = line.match(/^([^\s：:][^：:\n]{0,127})[：:]\s*(.*)$/u);
      if (before || after) { flush(); current = { speaker: (before?.[2] ?? after?.[1])!, time: (before?.[1] ?? after?.[2])!, parts: [] }; }
      else if (!timestamped && inline && !/^https?$/iu.test(inline[1]!)) { flush(); current = { speaker: inline[1]!.trim(), time: null, parts: [inline[2]!] }; }
      else if (current) current.parts.push(line);
      else if (line.trim()) throw new Error('imports.invalid');
    }
    flush();
  }
  if (!messages.length) throw new Error('imports.noText');
  if (messages.length > 2000 || messages.reduce((n, item) => n + item.text.length, 0) > 200_000) throw new Error('imports.tooLarge');
  const originalTranscript = transcriptDigest(messages);
  for (const [index, message] of messages.entries()) {
    message.sourceEventId = nativeSources.get(index) ?? digest(['import-transcript-event-v1', originalTranscript, index]);
    message.sourceEntityId = nativeEntities.get(index) ?? digest(['import-transcript-speaker-v1', originalTranscript, message.speakerId]);
    message.sourceIdentity = nativeSources.has(index) ? 'native' : 'transcript';
    message.sourceCollectionId = originalTranscript;
  }
  return { id: randomUUID(), name: name.trim().slice(0, 240) || 'WeChat', format, messages, skipped };
};
