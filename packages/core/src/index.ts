/**
 * @murmur/core 公共出口。
 */

export * from './types';
export { agentPaths, MURMUR_HOME, type AgentPaths } from './paths';
export { migrateLegacyHome, LEGACY_PERCH_HOME } from './migrate';
export { StatusEngine, STALE_AFTER_MS } from './engine/status-engine';
export { AgentRegistry } from './engine/registry';
export { Ledger } from './ledger/db';
export { estimateCostUsd, priceFor } from './ledger/pricing';
export { startIngestServer } from './ingest/server';
export { drainSpool } from './ingest/spool';
export { readEndpointFile, writeEndpointFile } from './ingest/endpoint';
export { renderHookScript, HOOK_MARKER } from './hooks/script';
export {
  writeHookScript,
  mergeJsonHooks,
  mergeTomlHooks,
  mergeTomlHooksText,
  mergeZcodeHooks,
  tomlHookInstalled,
  unmergeJsonHooks,
  unmergeTomlHooks,
  unmergeZcodeHooks,
  unmergeCodexNotify,
  removeHookScript,
  isHookInstalled,
  zcodeHookState,
} from './hooks/install';
export { DEFAULT_SETTINGS, flagEnabled, loadSettings, saveSettings, type MurmurSettings } from './settings';
export type { AgentAdapter } from './agents/base';
