/**
 * Locale dictionaries for the gitmemo settings page.
 *
 * The namespace is the plugin's own cordis id (kebab), which is also the
 * settings namespace and the profile entry id; the scoped npm package name is
 * reserved for package-bound identifiers (the module-loader id, the bundle
 * route base). zh is the key source of truth — en is typed against it, and the
 * locale registry re-checks the key sets at registration time.
 */

/** Dictionary namespace owned by this page. */
export const LOCALE_NS = 'dsh-gitmemo'

/** Simplified Chinese copy. */
export const zh = {
  settingsTitle: 'GitMemo',
  settingsSub: 'Git 长期记忆（.mem）中「系统一召回闸门」的配置。',
  enabled: '启用 System-one 召回闸门',
  enabledHint:
    '关闭后 mem_search 不再调用 System-one 模型，召回行为与门控存在前逐字节一致；此外仍需已配置密钥。',
  endpoint: 'System-one 接口地址',
  endpointHint: '接受 System-one 请求契约的 HTTP 端点；留空表示恢复默认地址。',
  model: '模型',
  modelHint: '请求体中携带的模型标识；留空表示恢复默认模型。',
  apiKey: 'API Key',
  apiKeyHint: '凭据不写入设置文件。留空表示保持当前密钥。',
  apiKeySet: '已配置密钥。',
  apiKeyUnset: '未配置密钥；配置之前召回闸门不生效。',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalidText: '该字段不接受这个值。',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。'
}

/** English copy; the key set must match {@link zh} exactly. */
export const en: Record<keyof typeof zh, string> = {
  settingsTitle: 'GitMemo',
  settingsSub: 'Configuration of the System-one recall gate over the Git-backed .mem memory.',
  enabled: 'Enable the System-one recall gate',
  enabledHint:
    'When off, mem_search never calls the System-one model and recall behaves byte-for-byte as it did before the gate existed; a credential is still required for it to run.',
  endpoint: 'System-one endpoint',
  endpointHint: 'HTTP endpoint accepting the System-one request contract; blank restores the default.',
  model: 'Model',
  modelHint: 'Model identifier sent in the request body; blank restores the default.',
  apiKey: 'API key',
  apiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  apiKeySet: 'A key is configured.',
  apiKeyUnset: 'No key is configured; the recall gate stays a no-op until one is.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  invalidText: 'This field does not accept that value.',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.'
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GitMemo settings page copy. */
    'dsh-gitmemo': keyof typeof zh
  }
}
