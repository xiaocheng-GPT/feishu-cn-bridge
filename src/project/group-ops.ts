import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/**
 * Transfer group ownership to `toOpenId`. Because the bridge creates project
 * groups (`chat.create`), the bot is the owner and members cannot disband the
 * group themselves — transferring ownership lets the admin disband it in
 * Feishu. Uses `im.v1.chat.update` (same `im:chat` scope as create); the bot
 * must currently be the owner for this to succeed.
 */
export async function transferOwnership(channel: LarkChannel, chatId: string, toOpenId: string): Promise<void> {
  await channel.rawClient.im.v1.chat.update({
    path: { chat_id: chatId },
    params: { user_id_type: 'open_id' },
    data: { owner_id: toOpenId },
  });
  log.info('project', 'owner-transfer', { chatId: chatId.slice(-6), to: toOpenId.slice(-6) });
}

/**
 * The bot leaves a group on its own (`me_leave`). Used to unbind a `joined`
 * project: the group is the user's, so the bot just exits — it never disbands
 * it (unlike a bridge-created group, where ownership is transferred so the admin
 * can disband). The SDK client doesn't wrap `me_leave`, so we call the raw
 * endpoint; the tenant token's identity (the bot) is the member that leaves, so
 * no member id / extra permission is needed. Needs `im:chat.members:write_only`.
 */
export async function leaveChat(channel: LarkChannel, chatId: string): Promise<void> {
  await channel.rawClient.request({
    method: 'PATCH',
    url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/me_leave`,
  });
  log.info('project', 'leave-chat', { chatId: chatId.slice(-6) });
}
