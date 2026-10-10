/** Owned offline formatter; fixed field facts and ARK=10 provenance are documented
 * in docs/merged-forward-card-internal.md. The formatter itself only constructs data; the public pipeline controls upload/send.
 */
export interface ForwardCardInput {
  resourceId: string;
  cardId: string;
  nodes: Array<{ displayName: string; text: string }>;
  options?: { title?: string; summary?: string; prompt?: string };
}
export interface ForwardCardElement {
  elementType: 10;
  elementId: '';
  arkElement: { bytesData: string };
}
const MAX = 1024 * 1024;
function record(
  value: unknown,
  allowed: string[],
  required: string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some((k) => typeof k !== 'string' || !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    throw Error(`Invalid ${label} fields`);
}
function utf8(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX)
    throw Error(`Invalid ${label}`);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = value.charCodeAt(++i);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw Error(`Unpaired surrogate in ${label}`);
    } else if (c >= 0xdc00 && c <= 0xdfff) throw Error(`Unpaired surrogate in ${label}`);
  }
  return value;
}
function preview(value: string): string {
  const points = Array.from(value);
  return points.length > 160 ? points.slice(0, 159).join('') + '…' : value;
}
export function buildMergedForwardCard(input: ForwardCardInput): ForwardCardElement {
  record(
    input,
    ['resourceId', 'cardId', 'nodes', 'options'],
    ['resourceId', 'cardId', 'nodes'],
    'card input',
  );
  const resourceId = utf8(input.resourceId, 'resourceId'),
    cardId = utf8(input.cardId, 'cardId');
  if (Buffer.byteLength(resourceId, 'utf8') > 4096)
    throw Error('resourceId exceeds 4096 UTF-8 bytes');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(cardId))
    throw Error('cardId must be a canonical UUID with version and variant');
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 100)
    throw Error('Card requires 1-100 dense nodes');
  let total = 0;
  const nodes = Array.from(input.nodes, (node) => {
    record(node, ['displayName', 'text'], ['displayName', 'text'], 'card node');
    const name = utf8(node.displayName, 'displayName'),
      text = utf8(node.text, 'text');
    total += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(text, 'utf8');
    if (total > MAX) throw Error('Card input exceeds 1 MiB');
    return { name, text };
  });
  let title = '聊天记录',
    summary = `查看${nodes.length}条消息`,
    prompt = '[聊天记录]';
  if (Object.hasOwn(input, 'options')) {
    record(input.options, ['title', 'summary', 'prompt'], [], 'card options');
    if (Object.hasOwn(input.options, 'title')) title = utf8(input.options.title, 'title');
    if (Object.hasOwn(input.options, 'summary')) summary = utf8(input.options.summary, 'summary');
    if (Object.hasOwn(input.options, 'prompt')) prompt = utf8(input.options.prompt, 'prompt');
  }
  const document = {
    app: 'com.tencent.multimsg',
    ver: '0.0.0.5',
    view: 'contact',
    config: { autosize: 1, forward: 1, round: 1, type: 'normal', width: 300 },
    extra: { filename: cardId, tsum: nodes.length },
    meta: {
      detail: {
        resid: resourceId,
        uniseq: cardId,
        news: nodes.map((node) => ({ text: preview(`${node.name}:${node.text}`) })),
        source: title,
        summary,
      },
    },
    desc: prompt,
    prompt,
  };
  const bytesData = JSON.stringify(document);
  if (Buffer.byteLength(bytesData, 'utf8') > MAX) throw Error('Card JSON exceeds 1 MiB');
  return { elementType: 10, elementId: '', arkElement: { bytesData } };
}
