/**
 * The gitmemo settings page's card: the gate's master switch, the System-one
 * endpoint, its model, and the API key — written through the credentials domain,
 * never into the settings section, so the literal never rides a response.
 *
 * The form chrome (read-only notice, unavailable notice, save, and the staged
 * save semantics) is the shared `SettingsForm`/`SettingsValueField`/
 * `SettingsSecretField` kit, so this page behaves exactly like a shipped one.
 */

import { Button, SettingsForm, SettingsSecretField, SettingsValueField, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFieldProps, SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { LOCALE_NS } from './locales'
import type { GitMemoSettingsFace } from './controller'

/**
 * The boolean control of this page: the gate's master switch.
 *
 * `dsh-client-ui-primitives` ships no boolean settings field (only
 * `SettingsValueField`, whose control is a text input, and `SettingsSecretField`),
 * so this builds the same field chrome from the primitives that ARE exported —
 * the shipped `Switch`, the overridden `Tag`, and a `ghost` `Button` for the
 * reset — in the vertical rhythm the shipped fields above and below it use.
 * Styling reads the host's own `--dsw-alias-*` tokens instead of shipping a
 * stylesheet, so the row tracks the active theme like everything around it.
 */
interface SettingsSwitchFieldProps
  extends Omit<SettingsFieldProps, 'text' | 'invalid' | 'invalidLabel' | 'onEdit'> {
  /** Whether the switch reads as on. */
  checked: boolean
  /** Stage the requested state. */
  onEdit: (next: boolean) => void
}

/**
 * Render one labelled boolean field.
 * @param props - the field's copy, its staged state, and the edit actions.
 * @returns the labelled switch.
 */
function SettingsSwitchField(props: SettingsSwitchFieldProps): JSX.Element {
  const { id, label, hint, checked, overridden, overriddenLabel, resetLabel, disabled, onEdit, onReset } = props
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        {/* The Switch carries the accessible name itself (aria-label), so this
            stays presentational: a <label> around the whole row would also
            toggle the switch when the reset button beside it is clicked. */}
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>{label}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {overridden ? (
            <>
              <Tag tone="neutral">{overriddenLabel}</Tag>
              <Button variant="ghost" size="sm" type="button" disabled={disabled} onClick={onReset}>
                {resetLabel}
              </Button>
            </>
          ) : null}
          <Switch checked={checked} onChange={onEdit} label={label} disabled={disabled} />
        </span>
      </div>
      <p id={`${id}-hint`} style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
        {hint}
      </p>
    </div>
  )
}

/** Props the renderer binds for the gitmemo page. */
export type GitMemoSettingsSectionProps = PropsRuntime<'settings.section'> &
  PropsLocale<typeof LOCALE_NS> &
  InjectFace<GitMemoSettingsFace>

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
function formLabels(t: GitMemoSettingsSectionProps['t']): SettingsFormLabels {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving')
  }
}

/**
 * Render the gitmemo settings page.
 * @param props - locale copy, the staged form state, and its actions.
 * @returns the settings form.
 */
export function GitMemoSettingsSection(props: GitMemoSettingsSectionProps): JSX.Element {
  const { t, useGitMemoSettings, edit, resetField, save, discard } = props
  const state = useGitMemoSettings((snapshot) => snapshot)
  const sectionDisabled = !state.writable
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={save} onDiscard={discard}>
      <SettingsSwitchField
        id="dsh-gitmemo-systemone-enabled"
        label={t('enabled')}
        hint={t('enabledHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={sectionDisabled}
        /* An absent value means the declared default (enabled), so the field's
           draft is seeded with 'true' rather than an empty string. */
        checked={state.enabled.text === 'true'}
        overridden={state.enabled.overridden}
        onEdit={(next) => {
          edit('enabled', String(next))
        }}
        onReset={() => {
          resetField('enabled')
        }}
      />
      <SettingsValueField
        id="dsh-gitmemo-systemone-endpoint"
        label={t('endpoint')}
        hint={t('endpointHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={sectionDisabled}
        {...state.endpoint}
        onEdit={(text) => {
          edit('endpoint', text)
        }}
        onReset={() => {
          resetField('endpoint')
        }}
      />
      <SettingsValueField
        id="dsh-gitmemo-systemone-model"
        label={t('model')}
        hint={t('modelHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={sectionDisabled}
        {...state.model}
        onEdit={(text) => {
          edit('model', text)
        }}
        onReset={() => {
          resetField('model')
        }}
      />
      <SettingsSecretField
        id="dsh-gitmemo-systemone-apikey"
        label={t('apiKey')}
        hint={t('apiKeyHint')}
        disabled={!state.apiKeyWritable}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset')}
        onEdit={(text) => {
          edit('apiKey', text)
        }}
      />
    </SettingsForm>
  )
}
