import { describe, expect, it } from 'vitest';
import { extractRawCardText, isDegradedCardContent, parseRawCardWrapper } from '../src/bot/card-content';

// The real `json_card` returned by
//   GET /open-apis/im/v1/messages/:id?card_msg_content_type=raw_card_content
// for a 多维表格「发送消息卡片」automation card (captured live, slimmed).
const REAL_JSON_CARD = {
  body: {
    id: '_1',
    property: {
      elements: [
        {
          id: '_2',
          property: {
            elements: [
              { id: '_2_0', property: { userID: 'ou_ca62bad132e8a939051cc575a64c34e9' }, tag: 'at' },
              { id: '_2_1', property: { content: ' 请处理这条记录 ', textAlign: 'left' }, tag: 'plain_text' },
              {
                id: '_2_2',
                property: {
                  content: '查看杭州天气',
                  url: { url: 'https://my.feishu.cn/base/B9lIbXRuFaE7oOsP7q3cbzqqneg?table=tbl9QY31p4n9iS89&record=rec27E5vQq5cvL' },
                },
                tag: 'link',
              },
            ],
            originTag: 'markdown',
          },
          tag: 'markdown',
        },
        {
          id: '_3',
          property: {
            columns: [
              {
                id: '_4',
                property: {
                  elements: [
                    {
                      id: '_5',
                      property: {
                        actions: [{ action: { url: 'https://my.feishu.cn/base/B9lIbXRuFaE7oOsP7q3cbzqqneg?ccm_open_type=im_card_automation_button' }, type: 'open_url' }],
                        text: {
                          id: '_6',
                          property: { elements: [{ id: '_6_0', property: { content: '查看详情' }, tag: 'plain_text' }] },
                          tag: 'markdown',
                        },
                      },
                      tag: 'button',
                    },
                  ],
                },
                tag: 'column',
              },
            ],
          },
          tag: 'column_set',
        },
        { id: '_7', property: {}, tag: 'hr' },
        {
          id: '_8',
          property: {
            elements: [],
            i18nElements: {
              en_us: [
                { id: '_8_en_us_0', property: { content: 'From ' }, tag: 'plain_text' },
                { id: '_8_en_us_1', property: { content: 'Untitled base', url: { url: 'https://my.feishu.cn/base/B9lIbXRuFaE7oOsP7q3cbzqqneg?ccm_open_type=im_card_automation_link' } }, tag: 'link' },
              ],
              zh_cn: [
                { id: '_8_zh_cn_0', property: { content: '来自 ' }, tag: 'plain_text' },
                { id: '_8_zh_cn_1', property: { content: '未命名多维表格', url: { url: 'https://my.feishu.cn/base/B9lIbXRuFaE7oOsP7q3cbzqqneg?ccm_open_type=im_card_automation_link' } }, tag: 'link' },
              ],
            },
          },
          tag: 'markdown',
        },
      ],
    },
    tag: 'body',
  },
  header: {
    property: { title: { property: { content: '请关注记录' }, tag: 'plain_text' } },
    tag: 'card_header',
  },
  schema: '2.0',
};

describe('isDegradedCardContent', () => {
  it('flags the SDK fallback and the client-upgrade placeholder', () => {
    expect(isDegradedCardContent('[interactive card]')).toBe(true);
    expect(isDegradedCardContent('  ')).toBe(true);
    expect(isDegradedCardContent('请升级至最新版本客户端，以查看内容')).toBe(true);
  });
  it('leaves real content alone', () => {
    expect(isDegradedCardContent('请处理这条记录')).toBe(false);
  });
});

describe('parseRawCardWrapper', () => {
  it('unwraps the json_card envelope', () => {
    const body = JSON.stringify({ json_card: JSON.stringify({ schema: '2.0' }), json_attachment: {} });
    expect(parseRawCardWrapper(body)).toEqual({ schema: '2.0' });
  });
  it('returns the parsed body when not wrapped, undefined on garbage', () => {
    expect(parseRawCardWrapper('{"a":1}')).toEqual({ a: 1 });
    expect(parseRawCardWrapper('not json')).toBeUndefined();
  });
});

describe('extractRawCardText', () => {
  const text = extractRawCardText(REAL_JSON_CARD);

  it('leads with the card title', () => {
    expect(text.split('\n')[0]).toBe('请关注记录');
  });

  it('keeps the body text and the Base record link', () => {
    expect(text).toContain('请处理这条记录');
    expect(text).toContain('[查看杭州天气](https://my.feishu.cn/base/B9lIbXRuFaE7oOsP7q3cbzqqneg?table=tbl9QY31p4n9iS89&record=rec27E5vQq5cvL)');
  });

  it('keeps the button label and the footer source link', () => {
    expect(text).toContain('查看详情');
    expect(text).toContain('[未命名多维表格](https://my.feishu.cn/base/B9lIbXRuFaE7oOsP7q3cbzqqneg?ccm_open_type=im_card_automation_link)');
  });

  it('renders the footer in one locale only (no ×5 i18n duplication)', () => {
    expect(text).toContain('来自');
    expect(text).not.toContain('From ');
    expect(text).not.toContain('Untitled base');
  });

  it('drops the @ placeholder and empties (no bare open_id, no blank lines)', () => {
    expect(text).not.toContain('ou_ca62bad132e8a939051cc575a64c34e9');
    expect(text.split('\n').every((l) => l.trim().length > 0)).toBe(true);
  });

  it('yields nothing for an empty / unparseable card', () => {
    expect(extractRawCardText({})).toBe('');
    expect(extractRawCardText(null)).toBe('');
  });
});
