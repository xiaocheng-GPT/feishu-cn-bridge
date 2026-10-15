import type { TenantBrand } from './schema';

/**
 * The app-identity scopes this bridge needs (design §9). Single source of
 * truth — keep in sync with the design doc's scope list.
 *
 * Feishu has **no API to declare app scopes**: the scan-create flow
 * (`registerApp`) takes no permission argument, and so does the official
 * larksuite/cli. The only way to grant them is the developer-console
 * "apply scope" page. So instead of baking scopes into the QR (impossible),
 * we point the user at one console URL that pre-selects *all* of these at
 * once — scan once, click once. See {@link buildScopeGrantUrl}.
 *
 * Cloud-doc comment scopes live in {@link COMMENT_SCOPES}, NOT here: the
 * comment-reply feature is an opt-in enhancement, so it must never block the
 * daemon-install scope gate (which loops on REQUIRED_SCOPES until granted).
 */
export const REQUIRED_SCOPES = [
  // Feishu has split the old umbrella scopes (`im:chat`, `im:message`) into
  // fine-grained ones; new apps can only be granted the fine-grained names, so
  // we list those — not the umbrellas (which would be un-grantable + would make
  // the scope check false-positive).
  'im:message.group_at_msg:readonly', // @bot messages in project groups
  'im:message.group_msg', // ALL group messages (高敏感) — required for 免@ (respond without @)
  'im:message.p2p_msg:readonly', // DM console messages
  'im:message:send_as_bot', // reply_in_thread / send cards
  'im:message.pins:write_only', // Pin the welcome/command card to the group's Pins tab (im.v1.pin.create) — NOTE: plural `pins`
  'im:message.reactions:write_only', // ⏳/🫳 run-status emoji reactions (best-effort) — NOTE: plural `reactions`
  'im:resource', // upload/download images & resources
  'im:chat:create', // create the project group
  'im:chat:update', // transfer ownership on unbind
  'im:chat.managers:write_only', // promote the project creator to group admin (im.v1.chat.managers.add_managers)
  'im:chat.announcement:read', // read group announcement blocks (list)
  'im:chat.announcement:write_only', // write group announcement blocks (create/delete)
  'im:chat.top_notice:write_only', // pin the announcement to the top banner
  'im:chat.tabs:write_only', // add the "👈 查看可使用的命令" chat tab on group create
  'cardkit:card:write', // interactive button cards (CardKit entities)
] as const;

/**
 * Optional scopes for the cloud-doc comment-reply feature (@bot inside a Feishu
 * doc comment → reply in-thread). Pre-selected in the one-click grant URL so a
 * user who wants the feature gets them in the same click, but deliberately NOT
 * in {@link REQUIRED_SCOPES}: the daemon-install gate loops on REQUIRED_SCOPES
 * until granted, and we must not block the (messaging) bot on an opt-in extra.
 * Without these, the comment event simply isn't pushed / the API calls fail and
 * we log + skip — everything else still works.
 *
 * Names are exact Feishu fine-grained tokens (verified against the API docs +
 * the official lark CLI scope registry). `:read` covers reading the comment AND
 * receiving the `drive.notice.comment_add_v1` event; `:create` covers posting
 * the reply and the comment "Typing" reaction; `wiki:wiki:readonly` (umbrella
 * readonly — chosen over the fine-grained `wiki:node:read` to dodge the
 * singular/plural scope-name pitfall, cf. c6317e7) resolves knowledge-base
 * (wiki) nodes to their underlying doc token.
 */
export const COMMENT_SCOPES = [
  'docs:document.comment:read',
  'docs:document.comment:create',
  'wiki:wiki:readonly',
] as const;

/**
 * Optional scopes for the "加入存量群" feature (a human adds the bot to a
 * pre-existing group → bot binds it as a `joined` project). Like
 * {@link COMMENT_SCOPES}, deliberately NOT in {@link REQUIRED_SCOPES}: the
 * daemon-install gate loops on REQUIRED_SCOPES until granted, and we must not
 * make an upgrade suddenly demand new permissions of every existing
 * messaging-only install. Without these, `getChatInfo` (read the group name)
 * and the me_leave-on-unbind call fail and we log + degrade — the rest still
 * works, and binding can still proceed with a manually-typed project name.
 *
 * `im:chat:readonly` = read the joined group's name/owner via im.v1.chat.get;
 * `im:chat.members:write_only` = the bot leaves the group (me_leave) when the
 * project is unbound from the console.
 */
export const JOIN_GROUP_SCOPES = [
  'im:chat:readonly',
  'im:chat.members:write_only',
] as const;

/**
 * Optional scope for resolving open_id → 姓名 in the admins / 项目白名单 management
 * cards. Like {@link COMMENT_SCOPES} / {@link JOIN_GROUP_SCOPES}, deliberately NOT
 * in {@link REQUIRED_SCOPES}: it gates only a display nicety (without it the cards
 * fall back to showing the open_id tail), so it must never block the daemon-install
 * scope gate. `contact:user.base:readonly` = read a user's basic info (name) via
 * contact.v3.user.batch.
 */
export const CONTACT_SCOPES = ['contact:user.base:readonly'] as const;

/**
 * Optional scope for the event-subscription auto-diagnosis (doctor / 启动自检 /
 * DM 诊断卡). `GET application/v6/applications/:app_id/app_versions` 的响应含
 * `events`（已订阅事件列表），凭它可三态诊断「从未发布版本 / 缺
 * im.message.receive_v1 / 配置齐全」——事件订阅本身没有写入类 API，这是唯一的
 * 只读检测通道（见 utils/event-diagnosis.ts）。Like the other opt-in groups,
 * deliberately NOT in {@link REQUIRED_SCOPES}: without it diagnosis degrades to
 * 「未能自动检测」and everything else still works — never gate startup on it.
 */
export const APP_VERSION_SCOPES = ['application:application.app_version:readonly'] as const;

/**
 * Optional scopes for the in-group discoverability trio (M-6):
 *   - `im:chat.menu_tree:write_only` — onboarding hangs a「🤖 Codex」group menu
 *     (im.v1.chatMenuTree.create) above the input box, far more visible than
 *     the chat tab;
 *   - `im:message.reactions:read` — receive the `im.message.reaction.created_v1`
 *     event (限机器人所在会话), powering 终态卡 👍=继续 / 运行卡 OK=终止.
 * Like the other opt-in groups, deliberately NOT in {@link REQUIRED_SCOPES}:
 * without them the menu create fails (log + skip) and reaction events simply
 * aren't pushed — everything else still works, never gate startup on these.
 */
export const DISCOVERY_SCOPES = [
  'im:chat.menu_tree:write_only',
  'im:message.reactions:read',
] as const;

/** Everything the one-click grant URL pre-selects: required + opt-in extras. */
export const GRANT_SCOPES = [
  ...REQUIRED_SCOPES,
  ...COMMENT_SCOPES,
  ...JOIN_GROUP_SCOPES,
  ...CONTACT_SCOPES,
  ...APP_VERSION_SCOPES,
  ...DISCOVERY_SCOPES,
] as const;

/**
 * Human-readable Chinese labels per scope token, so the doctor card can show
 * *which capability* a missing scope gates ("图片上传/下载") instead of a cryptic
 * `im:resource`. Keep keys in sync with {@link GRANT_SCOPES}; unknown tokens
 * fall back to the raw name (see {@link labelScope}).
 */
export const SCOPE_LABELS: Record<string, string> = {
  'im:message.group_at_msg:readonly': '接收群里 @机器人 的消息',
  'im:message.group_msg': '接收群内所有消息（免@）',
  'im:message.p2p_msg:readonly': '接收私聊消息（管理台）',
  'im:message:send_as_bot': '发送消息 / 卡片',
  'im:message.pins:write_only': '置顶消息到群 Pin',
  'im:message.reactions:write_only': '消息表情回复（运行状态）',
  'im:resource': '图片 / 文件上传与下载',
  'im:chat:create': '创建项目群',
  'im:chat:update': '转移群主（解绑时）',
  'im:chat.managers:write_only': '设置群管理员',
  'im:chat.announcement:read': '读取群公告',
  'im:chat.announcement:write_only': '编辑群公告',
  'im:chat.top_notice:write_only': '置顶群公告横幅',
  'im:chat.tabs:write_only': '添加群标签页',
  'im:chat:readonly': '读取群信息（群名/群主，加入存量群用）',
  'im:chat.members:write_only': '群成员增减（绑定的存量群解绑时机器人退群）',
  'cardkit:card:write': '交互按钮卡片',
  'docs:document.comment:read': '读取文档评论',
  'docs:document.comment:create': '发表文档评论回复',
  'wiki:wiki:readonly': '读取知识库节点',
  'contact:user.base:readonly': '读取成员姓名（管理员 / 白名单展示）',
  'application:application.app_version:readonly': '读取应用版本信息（自动诊断事件订阅）',
  'im:chat.menu_tree:write_only': '添加群菜单（群内常驻命令入口）',
  'im:message.reactions:read': '接收表情回复事件（终态卡 👍 续轮 / 运行卡 OK 终止）',
};

/** `<中文说明>（<token>）` for a known scope, else the raw token. */
export function labelScope(scope: string): string {
  const label = SCOPE_LABELS[scope];
  return label ? `${label}（${scope}）` : scope;
}

const HOSTS: Record<TenantBrand, string> = {
  feishu: 'open.feishu.cn',
  lark: 'open.larksuite.com',
};

/**
 * Developer-console URL that pre-selects every scope in `scopes` for the app,
 * so the user enables them all on a single page. Mirrors larksuite/cli's
 * format (`/app/<id>/auth?q=<comma-joined>`); scopes are URL-encoded so a
 * stray `&`/`#` can't inject extra query params. Defaults to {@link GRANT_SCOPES}
 * (required + opt-in comment) so the comment feature is one click away; the
 * missing-scope gate still only enforces {@link REQUIRED_SCOPES}.
 */
export function buildScopeGrantUrl(
  appId: string,
  tenant: TenantBrand,
  scopes: readonly string[] = GRANT_SCOPES,
): string {
  const host = HOSTS[tenant];
  const q = encodeURIComponent(scopes.join(','));
  return `https://${host}/app/${encodeURIComponent(appId)}/auth?q=${q}`;
}

/**
 * Developer-console "事件与回调" page for the app. Unlike scopes there is **no**
 * `?q=` pre-select and **no** API to subscribe events/callbacks for a self-built
 * app — both the 事件配置 (im.message.receive_v1, application.bot.menu_v6) and
 * 回调配置 (card.action.trigger / 卡片回传交互) tabs must be filled in by hand.
 * The best we can do is deep-link to the page and auto-open it. The subscription
 * *state* IS readable though (app-version API, see utils/event-diagnosis.ts), so
 * run/doctor diagnose precisely and announce once the config takes effect.
 */
export function buildEventConfigUrl(appId: string, tenant: TenantBrand): string {
  return `https://${HOSTS[tenant]}/app/${encodeURIComponent(appId)}/event`;
}
