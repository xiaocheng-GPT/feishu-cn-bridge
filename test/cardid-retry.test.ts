import { describe, expect, it } from 'vitest';
import { isCardIdNotReady } from '../src/card/managed';
import { RunCardStream } from '../src/card/run-card-stream';
import { card, md } from '../src/card/cards';

/** Feishu's entity-not-propagated error: 400 with code 230099 / ErrCode 11310. */
function cardIdNotReadyErr(): unknown {
  return {
    message: 'Request failed with status code 400',
    response: { data: { code: 230099, msg: 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: cardid is invalid; ' } },
  };
}

describe('isCardIdNotReady', () => {
  it('matches the 230099 / 11310 propagation-lag transient', () => {
    expect(isCardIdNotReady(cardIdNotReadyErr())).toBe(true);
    expect(isCardIdNotReady({ response: { data: { code: 230099 } } })).toBe(true);
    expect(isCardIdNotReady({ response: { data: { msg: 'cardid is invalid' } } })).toBe(true);
  });
  it('does NOT match genuine errors / network losses (never retries those)', () => {
    expect(isCardIdNotReady({ response: { data: { code: 99991663, msg: 'rate limited' } } })).toBe(false);
    expect(isCardIdNotReady(new Error('socket hang up'))).toBe(false);
    expect(isCardIdNotReady(undefined)).toBe(false);
  });
});

/** Minimal fake LarkChannel.rawClient that fails the message-send N times with the
 * propagation transient, then succeeds — to exercise create()'s retry loop. */
function fakeChannel(failSends: number, sendErr: () => unknown) {
  let creates = 0;
  let sends = 0;
  const ok = { data: { message_id: 'om_ok' } };
  return {
    creates: () => creates,
    sends: () => sends,
    rawClient: {
      cardkit: { v1: { card: { create: async () => { creates++; return { data: { card_id: `cs_${creates}` } }; } } } },
      im: {
        v1: {
          message: {
            reply: async () => { sends++; if (sends <= failSends) throw sendErr(); return ok; },
            create: async () => { sends++; if (sends <= failSends) throw sendErr(); return ok; },
          },
        },
      },
    },
  } as any;
}

describe('RunCardStream.create — cardid-not-ready retry', () => {
  const initial = () => card([md('hi')]);

  it('retries the create+send on the 11310 transient and returns the message id', async () => {
    const ch = fakeChannel(1, cardIdNotReadyErr); // fail once, then succeed
    const s = new RunCardStream();
    const mid = await s.create(ch, 'oc_1', initial(), {});
    expect(mid).toBe('om_ok');
    expect(ch.creates()).toBe(2); // re-created the entity on retry (first orphaned)
    expect(ch.sends()).toBe(2);
  });

  it('does not retry a genuine error — surfaces it immediately', async () => {
    const ch = fakeChannel(1, () => ({ response: { data: { code: 99991663, msg: 'boom' } } }));
    const s = new RunCardStream();
    await expect(s.create(ch, 'oc_1', initial(), {})).rejects.toBeTruthy();
    expect(ch.sends()).toBe(1); // one attempt, no retry
  });
});
