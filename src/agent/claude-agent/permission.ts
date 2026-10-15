import type { Options, SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '../types';

/**
 * Map a bridge permission tier (qa / write / full) to the Claude Agent SDK
 * options that enforce it WITHOUT prompting a human (codex runs approvalPolicy
 * 'never' — we match that: full bypasses prompts; qa/write use the OS sandbox as
 * the boundary and `bypassPermissions` so no prompt ever blocks a turn).
 *
 * Verified empirically (spikes, SDK 0.3.178, macOS):
 *  - `sandbox.enabled` confines Bash writes to the workspace (cwd) at the OS level
 *    even under `permissionMode:'bypassPermissions'` (a /tmp write → "operation not
 *    permitted"; a cwd write succeeds).
 *  - The model CAN escape the sandbox via the Bash `dangerouslyDisableSandbox`
 *    parameter UNLESS `allowUnsandboxedCommands:false` — so we MUST set it false to
 *    make the sandbox a hard boundary (without it, qa/write are NOT enforceable).
 *  - `filesystem.denyWrite:[cwd]` makes even cwd read-only (→ qa).
 *  - `failIfUnavailable:true` → the turn errors (visible) instead of running
 *    unsandboxed if the OS sandbox can't start. Fail-closed, never a silent
 *    downgrade. (Claude's sandbox: macOS Seatbelt / Linux bubblewrap.)
 *
 * ── Security delta vs codex (kept truthful) ──────────────────────────────────
 *  - WRITE confinement to cwd: enforced at the OS level (sandbox + no-escape).
 *    On par with codex's write tier.
 *  - QA read-only: writes denied everywhere (denyWrite:[cwd] + the sandbox's own
 *    out-of-workspace block + write tools removed + no unsandboxed escape). Reads
 *    are NOT yet hard-confined to cwd (codex's qa also restricts reads on
 *    macOS/Windows); a Read/Bash read can still reach outside cwd. Documented gap.
 *  - NETWORK: when off, the network-reaching tools (WebFetch/WebSearch) are removed
 *    and the sandbox isolates Bash network by default; fine-grained Bash-network
 *    parity with codex's `network.enabled` is best-effort (verify before trusting
 *    qa with an untrusted external group that needs network off as a hard gate).
 */

// File-writing built-in tools to strip in qa (read-only). Names per SDK 0.3.178
// (MultiEdit was folded into Edit; listing an unknown tool only warns, so we keep
// the real ones).
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];
const NETWORK_TOOLS = ['WebFetch', 'WebSearch'];

/** The subset of SDK options this module produces. Spread into query() options. */
export type ClaudePermissionOptions = Pick<
  Options,
  'permissionMode' | 'allowDangerouslySkipPermissions' | 'sandbox' | 'disallowedTools'
>;

export function permissionOptions(
  mode: PermissionMode | undefined,
  network: boolean | undefined,
  cwd: string,
): ClaudePermissionOptions {
  const tier = mode ?? 'full';

  // full: historical danger-full-access — no sandbox, no prompts, network open.
  if (tier === 'full') {
    return { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true };
  }

  const sandbox: SandboxSettings = {
    enabled: true,
    failIfUnavailable: true, // fail-closed: error out instead of running unsandboxed.
    autoAllowBashIfSandboxed: true, // sandboxed Bash needn't prompt — the sandbox is the gate.
    allowUnsandboxedCommands: false, // CRITICAL: block the dangerouslyDisableSandbox escape.
    ...(tier === 'qa' ? { filesystem: { denyWrite: [cwd] } } : {}),
  } as SandboxSettings;

  const disallowedTools: string[] = [];
  if (tier === 'qa') disallowedTools.push(...WRITE_TOOLS); // read-only: no write tools at all.
  if (!network) disallowedTools.push(...NETWORK_TOOLS); // offline: no network tools.

  return {
    // bypassPermissions = never prompt; the sandbox (above) is the real boundary.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    sandbox,
    ...(disallowedTools.length ? { disallowedTools } : {}),
  };
}
