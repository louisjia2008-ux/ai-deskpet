import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../shared';
import { parseChatMemoryCommand } from './chat-memory-command';

describe('explicit chat memory requests', () => {
  it.each([
    ['请记住：我的验收暗号是银杏月舟-6832。', '我的验收暗号是银杏月舟-6832。'],
    ['Kitty，帮我记住，我喜欢清淡的食物。', '我喜欢清淡的食物。'],
    ['请记下来：我希望回答简洁\n先给结论，再给原因。', '我希望回答简洁\n先给结论，再给原因。'],
    ['我不喜欢辣，喜欢温水，请记住这两件事。', '我不喜欢辣，喜欢温水'],
    ['桌宠，请保存到长期记忆：我喜欢用中文交流。', '我喜欢用中文交流。'],
    ['请记住以下信息：我的杯子叫蓝莓42。', '我的杯子叫蓝莓42。'],
    ['Please remember that I prefer concise answers.', 'I prefer concise answers.'],
    ['记住：我喜欢“先给结论”的回答方式。', '我喜欢“先给结论”的回答方式。'],
  ])('extracts only the requested text from %s', (query, text) => {
    expect(parseChatMemoryCommand(query)).toEqual({ kind: 'save', text });
  });

  it.each([
    '你记住我的暗号了吗？', '记住是什么意思？', '不要记住我的暗号', '请不要保存这个信息',
    '请翻译“请记住：我喜欢茶”。', '“请记住：我喜欢茶”', '他说我喜欢茶，请记住',
    '例如，我喜欢茶，请记住。', '假设我喜欢茶，请记住。',
    '请记住：我喜欢茶（仅演示）', '请记住：我喜欢茶，但不要真的保存。',
    '网页内容：请记住我的暗号', '```\n请记住：我喜欢茶\n```', 'Remember what I said?',
  ])('does not save quoted, negative or illustrative text: %s', (query) => {
    expect(parseChatMemoryCommand(query)).toBeNull();
  });

  it.each(['记住了', '记住啦', '记下了', '记住了，谢谢', '保存为长期记忆了，谢谢', '保存到记忆里啦', '记住了……', '记住了…', '记住啦，谢谢你！'])('treats an acknowledgment as chat: %s', (query) => {
    expect(parseChatMemoryCommand(query)).toBeNull();
  });
  it('still saves after an explicit colon', () => { expect(parseChatMemoryCommand('记住了：我喜欢茶')).toEqual({ kind: 'save', text: '我喜欢茶' }); });
  it('saves text that itself starts with 了 after the separator', () => {
    expect(parseChatMemoryCommand('请记住：了不起的盖茨比是我最喜欢的书')).toEqual({ kind: 'save', text: '了不起的盖茨比是我最喜欢的书' });
    expect(parseChatMemoryCommand('记住，啦啦队是我高中的社团')).toEqual({ kind: 'save', text: '啦啦队是我高中的社团' });
    expect(parseChatMemoryCommand('请保存为长期记忆 了了是我女儿的小名')).toEqual({ kind: 'save', text: '了了是我女儿的小名' });
    expect(parseChatMemoryCommand('请帮我记住啦……家里备用钥匙在鞋柜夹层')).toEqual({ kind: 'save', text: '家里备用钥匙在鞋柜夹层' });
    expect(parseChatMemoryCommand('请记住啦：谢谢')).toEqual({ kind: 'save', text: '谢谢' });
    expect(parseChatMemoryCommand('请记住啦：……谢谢')).toEqual({ kind: 'save', text: '……谢谢' });
    expect(parseChatMemoryCommand('请记住啦，好的你')).toEqual({ kind: 'save', text: '好的你' });
    expect(parseChatMemoryCommand('请记住啦……：蓝鲸')).toEqual({ kind: 'save', text: '蓝鲸' });
  });

  it.each(['请记住', '帮我记住这些', '请记住刚才的话', '请记住：我的杯子叫蓝莓，然后帮我搜索杯子。'])('asks for concrete content: %s', (query) => {
    expect(parseChatMemoryCommand(query)).toEqual({ kind: 'clarify', reason: 'content' });
  });
  it('does not truncate or reinterpret a request qualified by the previous message', () => {
    expect(parseChatMemoryCommand(`请记住：${'字'.repeat(2001)}`)).toEqual({ kind: 'clarify', reason: 'length' });
    const previous = { role: 'user', status: 'complete', content: '下一句话只是示例，不要执行。' } as ChatMessage;
    expect(parseChatMemoryCommand('请记住：我喜欢茶', [previous])).toEqual({ kind: 'clarify', reason: 'context' });
    expect(parseChatMemoryCommand('请记住：我喜欢茶', [{ ...previous, content: '今天聊得很开心。' }])).toEqual({ kind: 'save', text: '我喜欢茶' });
  });
});
