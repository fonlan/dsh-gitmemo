/**
 * The gitmemo settings page's staged form over the `dsh-gitmemo` settings
 * namespace — the profile entry id of this package's host half.
 *
 * The API key is the one control that does not live in the section: its literal
 * never rides a response, so the page learns only whether one is configured for
 * the reference the section names, and writes it through the credentials domain.
 * It is still staged with the rest of the form, so one save covers everything
 * the page shows.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsFieldState, SettingsFormActions, SettingsFormScope, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { GitMemoFormModel, pathBooleanField, pathTextField, type GitMemoSettings } from './form-model'

/**
 * Settings namespace of this plugin. Spelled here rather than imported: a
 * client half must not depend on a host half, and the id is the profile entry
 * id the settings plane keys forms by.
 */
export const GITMEMO_NS = 'dsh-gitmemo'

/** Credential reference the host resolves when the section names none. */
export const DEFAULT_API_KEY_REF = 'TYPESAFE_API_KEY'

/** Form field the credential control stages under. */
const API_KEY_FIELD = 'apiKey'

/** What the gitmemo page renders. */
export interface GitMemoCardState extends SettingsFormShell {
  /** Whether the recall gate runs at all. */
  enabled: SettingsFieldState
  /** System-one endpoint. */
  endpoint: SettingsFieldState
  /** Model identifier sent in the request body. */
  model: SettingsFieldState
  /** The staged credential, which starts blank on every load. */
  apiKey: SettingsFieldState
  /** Whether the Host reports a credential configured for the referenced key. */
  apiKeyConfigured: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  apiKeyWritable: boolean
}

/** The registration-side face the gitmemo page's slot entry injects. */
export interface GitMemoSettingsFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useGitMemoSettings. */
    gitMemoSettings: HostObservable<GitMemoCardState>
  }
}

/** One credential reference's presence and writability, as the wire reports it. */
interface CredentialView {
  ref: string
  configured: boolean
  writable: boolean
}

/** Bridges the `dsh-gitmemo` scope and the credentials domain onto the page. */
export class GitMemoSettingsController {
  private readonly scope: SettingsFormScope<GitMemoSettings>
  private readonly ctx: ClientContext
  private readonly form: GitMemoFormModel<GitMemoSettings>
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private readonly unsubscribeForm: () => void
  private snapshot: GitMemoCardState
  private credential: CredentialView = { ref: '', configured: false, writable: true }

  /**
   * @param scope - the bound settings scope for the `dsh-gitmemo` namespace.
   * @param ctx - the page plugin's context, whose `remote.credentials` namespace
   * answers for the credential the section references.
   */
  constructor(scope: SettingsFormScope<GitMemoSettings>, ctx: ClientContext) {
    this.scope = scope
    this.ctx = ctx
    this.form = new GitMemoFormModel<GitMemoSettings>(
      scope,
      [
        pathBooleanField('enabled', ['systemOne', 'enabled']),
        pathTextField('endpoint', ['systemOne', 'endpoint']),
        pathTextField('model', ['systemOne', 'model'])
      ],
      [{ field: API_KEY_FIELD, write: (text) => this.writeKey(text) }]
    )
    this.snapshot = this.projection()
    // Host-state changes and staged drafts both move the page snapshot: the
    // scope subscription covers accepted values, the form subscription covers
    // drafts (text, the overridden badge, dirty, invalid, saving, failed).
    this.unsubscribe = scope.subscribe(() => {
      void this.readCredential()
      this.publish()
    })
    this.unsubscribeForm = this.form.subscribe(() => {
      this.publish()
    })
    void this.readCredential()
  }

  /** Read the current page snapshot (stable reference until the next change). */
  getSnapshot = (): GitMemoCardState => this.snapshot

  /** Observe page-snapshot replacements. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Re-read after the Host reports a change to the reference this page watches.
   * A key can be written from somewhere else, and the settings section does not
   * change when it is.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (ref !== this.credential.ref) return
    void this.readCredential()
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): GitMemoSettingsFace {
    return {
      hooks: { gitMemoSettings: { getSnapshot: this.getSnapshot, subscribe: this.subscribe } },
      ...this.form.actions()
    }
  }

  /** Release configuration subscriptions. */
  dispose(): void {
    this.unsubscribe()
    this.unsubscribeForm()
    this.form.dispose()
    this.listeners.clear()
  }

  private projection(): GitMemoCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      endpoint: this.form.field('endpoint'),
      model: this.form.field('model'),
      apiKey: this.form.field(API_KEY_FIELD),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable
    }
  }

  private publish(): void {
    this.snapshot = this.projection()
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Ask the credentials domain about the reference the section currently names.
   *
   * The answer is stored with the reference it describes: `apiKeyEnv` can change
   * between the request and its response, so a response is published only while
   * it still answers for the reference in force.
   */
  private async readCredential(): Promise<void> {
    const ref = refOf(this.scope.getSnapshot())
    if (ref !== this.credential.ref) {
      this.credential = { ref, configured: false, writable: true }
      this.publish()
    }
    const response = await this.ctx.remote.credentials.describe([ref])
    if (!response.ok || ref !== refOf(this.scope.getSnapshot())) return
    const view = response.value[ref]
    const next: CredentialView = { ref, configured: view?.configured ?? false, writable: view?.writable ?? true }
    if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
    this.credential = next
    this.publish()
  }

  /**
   * Write the staged key, then re-read whether the Host now holds one.
   * @param value - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  private async writeKey(value: string): Promise<boolean> {
    const response = await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot()), value)
    await this.readCredential()
    return response.ok && this.credential.configured
  }
}

/**
 * The credential reference the section names, or the host's default.
 * @param snapshot - the current scope snapshot.
 * @returns the reference to address.
 */
function refOf(snapshot: { value: GitMemoSettings | undefined }): string {
  const declared = snapshot.value?.systemOne?.apiKeyEnv
  return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
}
