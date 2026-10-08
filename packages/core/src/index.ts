/**
 * @murmur/core 公共出口。
 */

export * from './types';
export { agentPaths, MURMUR_HOME, type AgentPaths } from './paths';
export { migrateLegacyHome, LEGACY_PERCH_HOME } from './migrate';
export { StatusEngine, STALE_AFTER_MS } from './engine/status-engine';
export { AgentRegistry } from './engine/registry';
export { SELFTEST_PREFIX, assembleDiagnostics, probePath, runHookTest, selfTestPayload } from './engine/diagnostics';
export { Ledger } from './ledger/db';
export { estimateCostUsd, priceFor } from './ledger/pricing';
export { startIngestServer } from './ingest/server';
export { drainSpool } from './ingest/spool';
export { readEndpointFile, writeEndpointFile } from './ingest/endpoint';
export { renderHookScript, HOOK_MARKER } from './hooks/script';
export { renderOmpExtension } from './hooks/omp-script';
export {
  writeHookScript,
  mergeJsonHooks,
  mergeTomlHooks,
  mergeTomlHooksText,
  mergeZcodeHooks,
  mergeDevinHooks,
  mergeDevinHooksConfig,
  devinHooksRegistered,
  mergeQoderHooks,
  mergeQoderHooksConfig,
  qoderHooksRegistered,
  mergeClaudeHooks,
  mergeClaudeHooksConfig,
  claudeHooksRegistered,
  tomlHookInstalled,
  unmergeJsonHooks,
  unmergeTomlHooks,
  unmergeZcodeHooks,
  unmergeCodexNotify,
  removeHookScript,
  isHookInstalled,
  zcodeHookState,
} from './hooks/install';
export {
  installOmpExtension,
  uninstallOmpExtension,
  ompExtensionInstalled,
  ompExtensionPath,
} from './hooks/omp-install';
export { DEFAULT_SETTINGS, flagEnabled, loadSettings, saveSettings, type MurmurSettings } from './settings';
export { loadCredentials, saveCredentials, maskKey, type ByokCredential, type ByokStore } from './credentials';
export type { AgentAdapter } from './agents/base';
export { SyncService } from './sync/engine';
export { allSyncTargets, syncTargets, type McpTarget, type SyncTarget } from './sync/targets';
export { importSkills, listSourceSkills, readSourceMcp, type SourceSkill } from './sync/source';
export { sourceMcpEntry, saveSourceMcp } from './sync/source';
export { probeMcpServer } from './sync/probe';
