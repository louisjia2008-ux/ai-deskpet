import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Wire {
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ function: { name: string; description: string } }>;
}
export interface TelegramPost {
  chat_id: string;
  text: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}
export async function fakeTelegram(options: { cron?: boolean } = {}) {
  const token = '100:' + randomUUID().replaceAll('-', '');
  const owner = 701,
    stranger = 702;
  const updates: Array<{ update_id: number; [key: string]: unknown }> = [];
  const posts: TelegramPost[] = [],
    wires: Wire[] = [];
  let serial = 0,
    postId = 1000,
    online = true,
    polls = 0;
  let cronRuns = 0;
  let held: ServerResponse | undefined,
    holdClosed = false,
    delayed = false;
  const user = (id: number) => ({ id, first_name: 'Fixture ' + id, is_bot: false });
  const chat = (id: number) => ({ id, type: 'private', first_name: 'Fixture ' + id });
  const push = (value: Record<string, unknown>) => {
    updates.push({ update_id: ++serial, ...value });
  };
  const message = (text: string, id = owner) =>
    push({ message: { message_id: serial + 1, date: Math.floor(Date.now() / 1000), from: user(id), chat: chat(id), text } });
  const click = (data: string, id = owner) =>
    push({
      callback_query: {
        id: String(serial + 1),
        from: user(id),
        data,
        message: { message_id: postId, chat: chat(id), date: Math.floor(Date.now() / 1000) },
        chat_instance: 'fixture',
      },
    });
  const finish = (res: ServerResponse, delta: unknown, reason = 'stop') => {
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] }) + '\n\ndata: [DONE]\n\n');
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const url = new URL(req.url!, 'http://127.0.0.1');
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/v1/chat/completions') {
      const wire = body as Wire;
      wires.push(wire);
      const text = wire.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      if (options.cron && text === 'Create fixture recurring check') {
        if (wire.messages.at(-1)?.role === 'tool') {
          finish(res, { content: 'Desktop schedule created.' });
          return;
        }
        const name = wire.tools?.find((t) => t.function.description.startsWith('Create recurring chat task.'))?.function.name;
        if (!name) {
          json({ error: 'missing cron tool' }, 500);
          return;
        }
        finish(
          res,
          {
            tool_calls: [
              {
                index: 0,
                id: 'fixture-cron-create',
                type: 'function',
                function: {
                  name,
                  arguments: JSON.stringify({
                    title: 'Fixture minute check',
                    instruction: 'Run fixture minute check',
                    expression: '* * * * *',
                    timezone: 'UTC',
                    allowedCapabilities: [],
                    missedPolicy: 'skip',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        );
        return;
      }
      if (options.cron && text === 'Run fixture minute check') {
        finish(res, { content: 'Fixture scheduled result ' + ++cronRuns });
        return;
      }
      if (text.includes('fixture hold')) {
        held = res;
        holdClosed = false;
        res.once('close', () => {
          holdClosed = true;
        });
        return;
      }
      if (text.includes('fixture delayed') && !delayed) {
        held = res;
        holdClosed = false;
        delayed = true;
        return;
      }
      if (text.includes('fixture read')) {
        if (wire.messages.at(-1)?.role === 'tool') {
          finish(res, {
            content: wire.messages.at(-1)!.content.includes('LOCAL_TEST_FACT') ? 'Read: LOCAL_TEST_FACT' : 'Read declined.',
          });
          return;
        }
        const name = wire.tools?.find((t) => t.function.description.startsWith('Read workspace file'))?.function.name;
        if (name) {
          finish(
            res,
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'read-file',
                  type: 'function',
                  function: { name, arguments: JSON.stringify({ path: 'phone.txt' }) },
                },
              ],
            },
            'tool_calls',
          );
          return;
        }
      }
      finish(res, { content: 'Reply: ' + text });
      return;
    }
    if (url.pathname === '/v1/models') {
      json({ data: [{ id: 'controlled' }] });
      return;
    }
    if (!url.pathname.startsWith('/bot' + token + '/')) {
      json({ ok: false }, 404);
      return;
    }
    const api = url.pathname.split('/').at(-1);
    if (!online) {
      json({ ok: false, error_code: 503 }, 503);
      return;
    }
    if (api === 'getMe') {
      json({ ok: true, result: { id: 100, is_bot: true, first_name: 'Fixture', username: 'deskpet_fixture_bot' } });
      return;
    }
    if (api === 'getUpdates') {
      polls++;
      const offset = Number(body.offset ?? url.searchParams.get('offset') ?? 0);
      const read = () => updates.filter((u) => u.update_id >= offset);
      if (!read().length) await new Promise((resolve) => setTimeout(resolve, 100));
      json({ ok: true, result: read() });
      return;
    }
    if (api === 'sendMessage') {
      posts.push(body);
      if (body.text === 'Reply: fixture missing receipt') {
        json({ ok: true, result: { chat: chat(owner) } });
        return;
      }
      if (body.text === 'Reply: fixture wrong recipient') {
        json({ ok: true, result: { message_id: ++postId, chat: chat(stranger) } });
        return;
      }
      json({
        ok: true,
        result: {
          message_id: ++postId,
          date: Math.floor(Date.now() / 1000),
          chat: { ...chat(owner), id: body.chat_id },
          text: body.text,
        },
      });
      return;
    }
    if (api === 'answerCallbackQuery' || api === 'editMessageReplyMarkup') {
      json({ ok: true, result: true });
      return;
    }
    json({ ok: false, error_code: 404 }, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    base: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    token,
    owner,
    stranger,
    posts,
    wires,
    message,
    click,
    push,
    online: (value: boolean) => {
      online = value;
    },
    polls: () => polls,
    held: () => !!held && !holdClosed && !held.destroyed,
    release: (text: string) => {
      if (held) finish(held, { content: text });
      held = undefined;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
