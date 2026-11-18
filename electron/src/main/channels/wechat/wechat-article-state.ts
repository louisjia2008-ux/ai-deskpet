import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const printable = (value: string): boolean => !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
const title = z.string().min(1).max(160).refine(printable);
const account = z.string().max(80).refine(printable);
const url = z.string().max(500).regex(/^https:\/\/mp\.weixin\.qq\.com\/s(?:\/[\w-]+|\/?\?[A-Za-z0-9_%&=+-]+)$/u);
export const wechatArticleCardSchema = z.strictObject({ url, title, account });
export type WeChatArticleCard = z.infer<typeof wechatArticleCardSchema>;

const article = wechatArticleCardSchema.extend({ overview: z.string().min(1).max(480).refine(printable) });
const reply = z.string().min(1).max(550).refine(printable);
export const wechatArticleStateSchema = z.strictObject({
  latest: z.array(z.strictObject({
    binding: digest, eventId: digest, inputUrl: url, article: article.nullable(), reply,
    deferred: z.boolean(),
  })).max(32),
  favorites: z.array(article.extend({ binding: digest, key: digest })).max(1000),
  receipts: z.array(z.strictObject({ binding: digest, eventId: digest, command: z.string().max(1000), reply })).max(256),
});

export const defaultWeChatArticleState = (): z.infer<typeof wechatArticleStateSchema> => ({
  latest: [], favorites: [], receipts: [],
});
