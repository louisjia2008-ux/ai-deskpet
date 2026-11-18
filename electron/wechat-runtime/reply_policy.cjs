// Pure reply presentation policy, shared by the host and the flat listener runtime.
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const companionName = value => typeof value === 'string' && value.trim() && [...value].length <= 40
  && !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value) ? value.trim() : 'DeskPet';
const stageDirection = name => new RegExp('^(?:mood\\s*:\\s*[a-z]+|wink(?:s)?|smil(?:e|es|ing)|laugh(?:s|ing)?|giggl(?:e|es|ing)|wav(?:e|es|ing)|\\d{1,2}|(?:轻轻|悄悄|偷偷|忍不住|开心地)?(?:开心|高兴|害羞|微笑|笑(?:了|起来|眯眯)?|挥挥?手|招招?手|摸摸?(?:你的|' + escapeRegExp(companionName(name)) + '的)?头|拍拍?(?:你的)?肩|点点?头|摇摇?头|眨眨?眼|歪歪?头|伸个?懒腰|抱抱(?:你)?|举爪|贴贴|转个?圈|摇尾巴))(?:[~～。！!])?$', 'iu');
const leadingMood = /^(?:\[(?!content\s*[:：])[a-z][a-z _:-]{0,28}\]\s*[:：]?\s*|[\[【](?:(?:mood|情绪)[:：]\s*)?(?:开心|高兴|快乐|喜欢|害羞|难过|伤心|好奇|惊讶|惊喜|生气|疲倦|困|委屈)[\]】]\s*)+/iu;
const contentWrapper = /^\[(?:content|回复)[:：]\s*([^\r\n]+)\]$/iu;
const bracketedDirection = /[（(【\[]([^\r\n()（）【】\[\]]{1,30})[）)】\]]|(?<!\*)\*([^\r\n*]{1,30})\*(?!\*)/gu;
const explanationLine = /^(?:note\b\s*[:：]|[（(]?(?:回复|说明|注|备注)[）)\s:：])/iu;
const physicalFirstPerson = /(?:^|[，。！？!?；;：:\s]|对了|其实|刚好|刚才)我(?:们|自己|本人)?(?:刚{1,3}|刚才|今天|昨天|前天|早上|刚刚|下午|晚上|现在|已经|也|还|才|就|正在|正|刚好|都|没|没有|不小心){0,5}(?:吃|喝|尝|去(?:了|过|上学|学校|上班|公司)|到(?:了|过|家|学校|公司)|迟到|起床|睡醒|买(?:了|过)|见(?:了|过)|看(?:了|过|见)|听(?:了|过|见)|跑(?:了|过)|出门|回家|下班|上班|上课|请假|出发)/u;
const implicitPhysical = /(?:^|[。！？!?；;，,：:])\s*(?:(?:刚{1,3}|刚才|今天|昨天|早上|下午|晚上|已经|也|才|刚好|没|没有)\s*){1,4}(?:吃(?:了|过)|喝(?:了|过)|尝(?:了|过)|买(?:了|过)|去(?:了|过)|刚到|到(?:了|过)(?:学校|公司|家)|上(?:班|课)(?:了|过)|睡醒(?:了)?|出门(?:了)?)/u;
const attendanceClaim = /(?:^|[，。！？!?；;：:\s]|那就|原来|看来|还好|幸好|放心)(?:你(?:今天|刚才|刚刚|这次|还|也|肯定|确实|真的){0,4})?(?:没(?:有)?迟到|准时到(?:了|达)|迟到(?:了|啦|呀|哦))(?![吗么])/u;
const onTime = /没(?:有)?迟到|准时到(?:了|达)/u;
const late = /(?<!没)(?<!没有)迟到(?:了|啦|呀|哦)(?![吗么])/u;
const unsolicitedOffer = /(?:你要不要|要不要我|需不需要我|需要我(?:帮|给|替|为)|我(?:也|还)?可以(?:帮|替|给|为)你|我来(?:帮|替)你)/u;
const requestedHelp = /(?:能|可不可以|可以|请|麻烦|想让|想请|希望|要不要|怎么|怎么办).{0,12}(?:帮|做|查|给|替|教|告诉|看看|推荐|建议)|(?:帮帮我|帮我|求助|如何|请问|怎么|怎么办)/u;
const inventedSchedule = /(?:[零一二两三四五六七八九十\d]{1,3}(?:点(?:钟|半)?|[:：]\d{2})|(?:明天|后天|下周).{0,8}(?:会有|要上|会去|记得|一定))/gu;
const physicalTogether = /(?:咱们|我们|我陪你|我跟你)(?:就|也|再|都|来|可以|要)?(?:一起|一块儿?)?(?:去学校|到校|到学校|上课|上学|去公司|回家|吃冰淇淋|下课)/u;

function stripCompanionMention(text, name, bare = false) {
  const escaped = escapeRegExp(companionName(name));
  const withoutAt = text.replace(new RegExp('^@' + escaped + '[，,：:\\s]+', 'u'), '');
  return bare ? withoutAt.replace(new RegExp('^' + escaped + '[，,：:\\s]*(?=\\S)', 'u'), '') : withoutAt;
}

function plainReply(text, incoming, name, options = {}) {
  const stage = stageDirection(name);
  const visible = text.trim().replace(leadingMood, '').replace(bracketedDirection,
    (match, bracket, emphasis) => stage.test((bracket ?? emphasis).trim()) ? '' : match).trim();
  const lines = visible.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const explanation = lines.findIndex(line => explanationLine.test(line));
  const body = (explanation < 0 ? lines : lines.slice(0, explanation)).join(' ');
  let reply = (contentWrapper.exec(body)?.[1] ?? body).replace(leadingMood, '');
  if (options.stripMention !== false) reply = stripCompanionMention(reply, name);
  reply = reply.replace(/^`(?!``)|(?<!``)`$/gu, '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu, '').trim();
  const attendance = attendanceClaim.exec(reply)?.[0];
  const stated = attendance && (onTime.test(attendance) ? onTime : late).test(incoming) && !/[？?]|吗[呀呢]?\s*$/u.test(incoming);
  const promptDiscussion = new RegExp('(?:聊天内容|刚才的回复|最新消息|舞台说明|这条消息|最新来信|以' + escapeRegExp(companionName(name)) + '的身份)', 'u');
  const selfAsAddressee = new RegExp('(?:^|[，,。！？!?：:\\s])@?' + escapeRegExp(companionName(name)) + '(?=[，,。！？!?：:\\s]|$)', 'u');
  if (!reply || [...reply].length > 72 || /[\p{Cc}\u2028\u2029]|<\/?think>|https?:\/\/|^[\[【`]/iu.test(reply)
    || /[\[【]\s*(?:mood|情绪)\s*[:：]/iu.test(reply) || /^[\s，。！？!?、…~～]*$/u.test(reply) || stage.test(reply)
    || selfAsAddressee.test(reply) || physicalFirstPerson.test(reply) || implicitPhysical.test(reply)
    || (attendance && !stated) || [...reply.matchAll(inventedSchedule)].some(([detail]) => !incoming.includes(detail)) || physicalTogether.test(reply)
    || (promptDiscussion.test(reply) && !promptDiscussion.test(incoming)) || (unsolicitedOffer.test(reply) && !requestedHelp.test(incoming))
    || (options.chinese !== false && (reply.match(/\p{Script=Han}/gu)?.length ?? 0) < (reply.match(/[a-z]/giu)?.length ?? 0))
    || ([...incoming].length >= 6 && reply.includes(incoming))) return null;
  return reply;
}
module.exports = { companionName, escapeRegExp, plainReply, stripCompanionMention };
