/**
 * 账号用量数据层 facade —— bot/卡片层唯一允许的取数入口（对 codex-appserver 的
 * 深 import 收编在 src/agent 内，M-8）。用量目前是 codex（ChatGPT 登录）专属
 * 能力；对外类型是归一化形状（UsageError/AccountUsageBundle 等，见 ./types），
 * 未来别的后端有等价数据时在这里按后端路由。
 */
export { fetchUsageBundle } from './codex-appserver/usage';
