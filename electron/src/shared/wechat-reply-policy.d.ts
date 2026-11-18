declare module '*reply_policy.cjs' {
  export function companionName(value?: string): string;
  export function escapeRegExp(value: string): string;
  export function stripCompanionMention(text: string, name?: string, bare?: boolean): string;
  export function plainReply(text: string, incoming: string, name?: string, options?: {stripMention?: boolean; chinese?: boolean}): string | null;
}
