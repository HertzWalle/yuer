/**
 * 云端大脑的 system 提示词拼装：逐字复刻 dsh-pet 的 composeSystemPrompt。
 *
 * dsh-pet（src/host/persona.ts）的 system = ①人设正文 ②「你的名字是"X"。」③时间背景，
 * 三段用 \n 连接、空段省略。云端没有 DSH 宿主，所以这里自己实现一份；顺序与措辞必须一致，
 * 否则同一个 pet.json 在桌面端和云端会表现出两种性格。
 *
 * 与 dsh-pet 的差异（有意为之，README 有记）：
 * 1) 不实现节日从句（那需要农历表）；
 * 2) 名字行后面多一句「聊天记录里如果出现别的名字，那是以前的身份，现在只用这个名字自称。」——
 *    否则换人格后历史里旧名字的自称会把模型带偏（实测切到你鱼姐仍自称「小蓝」）。
 * 其余（日期/星期/时刻/时段/工作日或周末）逐字照抄。
 */

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 整点 → 时段（与 dsh-pet src/host/time-context.ts 的 SLOTS 表一致：取不大于 hour 的最大档） */
const SLOTS = [
  [23, '深夜'],
  [19, '晚上'],
  [17, '傍晚'],
  [13, '下午'],
  [11, '中午'],
  [9, '上午'],
  [7, '早上'],
  [5, '清晨'],
  [0, '凌晨'],
];

export function timeSlotOf(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return '凌晨';
  for (const [from, name] of SLOTS) if (h >= from) return name;
  return '凌晨';
}

export function dayKindOf(day) {
  const d = Number(day);
  if (!Number.isFinite(d)) return '工作日';
  return d === 0 || d === 6 ? '周末' : '工作日';
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 时间背景一行（对应 dsh-pet 的 timeContextOf） */
export function timeContextOf(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const day = date.getDay();
  const hour = date.getHours();
  return (
    '【当下】现在是' +
    date.getFullYear() +
    '年' +
    (date.getMonth() + 1) +
    '月' +
    date.getDate() +
    '日' +
    (WEEKDAYS[day] ?? '星期?') +
    ' ' +
    pad2(hour) +
    ':' +
    pad2(date.getMinutes()) +
    '，' +
    timeSlotOf(hour) +
    '，' +
    dayKindOf(day) +
    '。这只是背景，不必刻意报时，也别句句都提节日——多数时候正常说话就好，真贴切时才顺口带一句。'
  );
}

/**
 * 拼出最终 system：人设正文 + 名字声明 + 时间背景。
 * @param {{prompt?: string, name?: string, id?: string, now?: Date}} parts
 */
export function composeSystemPrompt(parts) {
  const name = String(parts?.name || parts?.id || '');
  const prompt = typeof parts?.prompt === 'string' ? parts.prompt : '';
  // 换人格时旧名字还留在聊天记录里，模型会顺着历史自称旧名字；这句把它钉住。
  // 「别的自称」也要管：你鱼姐爱说「姐」，切到小蓝后模型会跟着学（实测过）。
  const nameLine = name
    ? '你的名字是“' + name + '”。聊天记录里如果出现别的名字、或者别的自称（比如“姐”“本鱼”），那是以前的身份，现在只用这个名字和这个语气说话。'
    : '';
  const lines = [prompt, nameLine].filter((line) => line !== '');
  const time = timeContextOf(parts?.now ?? new Date());
  if (time) lines.push(time);
  return lines.join('\n');
}
