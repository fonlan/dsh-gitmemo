/**
 * dsh-gitmemo settings page, browser half.
 *
 * DSH 0.1.7-alpha.1 ships no client that auto-generates a settings page from a
 * plugin's schema (`@deepseek-ai/dsh-settings/README.md`: "no shipped client
 * does so yet"), so this plugin ships its own page. It rides the settings
 * namespace named by the profile entry id — `dsh-gitmemo` — which is the
 * namespace the host half's `.volatile()` `systemOne` fields are exposed under,
 * and registers into the `settings.section` list slot: one entry in the settings
 * sidebar, its content rendered into the panel's content column.
 *
 * Registration is gated on the Host actually serving that namespace
 * (`configForms.whileServed`), so a deployment that never loaded this plugin
 * shows no trace of the page.
 */

import type { Context } from '@deepseek-ai/cordis'
type ClientContext = Context
// Type-only: each import installs a declaration this page compiles against —
// the client services (`slots`, `locale`, `remote`, `configForms`), the
// `settings.section` slot contract, and the generated `remote.credentials`
// namespace. They are erased before the bundle purity gate ever sees them.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import { GitMemoSettingsSection } from './card'
import { GitMemoSettingsController, GITMEMO_NS } from './controller'
import { LOCALE_NS, zh, en } from './locales'

/** The settings sidebar entry this plugin's page owns (must stay stable). */
const SETTINGS_SECTION_ID = 'dsh-gitmemo'

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/**
 * Mount the gitmemo settings page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Live translate bound to the active locale (labels re-read it per call).
  const t = ctx.locale.bind(LOCALE_NS)
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-gitmemo: dictionaries')

  // One staged form over the `dsh-gitmemo` namespace, plus the credentials
  // domain read the API-key control's Set / Not-set badge reports.
  const controller = new GitMemoSettingsController(ctx.configForms.get(GITMEMO_NS), ctx)
  ctx.effect(
    () => () => {
      controller.dispose()
    },
    'dsh-gitmemo: settings form'
  )
  ctx.effect(
    () =>
      ctx.remote.$on('credentials/reference-updated', (ref) => {
        controller.refreshCredential(ref)
      }),
    'dsh-gitmemo: credential invalidations'
  )

  ctx.effect(
    () =>
      ctx.configForms.whileServed([GITMEMO_NS], () =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SETTINGS_SECTION_ID,
              order: 200,
              label: () => t('settingsTitle'),
              locale: LOCALE_NS,
              inject: () => controller.inject()
            } as never,
            GitMemoSettingsSection as never
          )
        )
      ),
    'dsh-gitmemo: settings page'
  )
}
