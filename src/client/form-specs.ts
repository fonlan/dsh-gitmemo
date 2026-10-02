/**
 * The staged settings form's pure field vocabulary: how one section field
 * converts between its stored value and the draft text the card renders.
 *
 * Deliberately a plain TypeScript module with no React, DOM or browser import:
 * the card needs it and so do the unit tests, which cannot import the browser
 * bundle. The host tsconfig compiles plain `.ts` files under `src`, so this is
 * both inlined into the client bundle and emitted for the tests to import.
 */

import type { SettingsFieldWrite } from '@deepseek-ai/dsh-client-ui-primitives'

/** The editable projection of this plugin's settings namespace. */
export interface GitMemoSettings {
  /** The System-one recall gate, as `src/index.ts` declares it. */
  systemOne?: {
    enabled?: boolean
    endpoint?: string
    model?: string
    apiKey?: string
    apiKeyEnv?: string
    mode?: 'noul' | 'score'
    /** How the judge's values are used: order the page, or drop from it. */
    policy?: 'rerank' | 'filter'
    /** `filter` only: the share of a judged page that may be dropped. */
    maxDropFraction?: number
    threshold?: number
    scoreMin?: number
    minKeep?: number
    maxCandidates?: number
    maxTaskChars?: number
    timeoutMs?: number
  }
}

/** How one section field converts between its stored value and its draft text. */
export interface PathFieldSpec {
  /** Key addressing this control inside the card's form. */
  field: string
  /** Path inside the namespace section this control edits. */
  path: readonly string[]
  /** Render a stored value as draft text; the empty string when the section carries none. */
  format: (value: unknown) => string
  /** The write this draft text stages, or undefined when the text is not a value this field accepts. */
  parse: (text: string) => SettingsFieldWrite | undefined
}

/**
 * A free-text field. An empty draft clears the field, so emptying the control
 * and saving is the same gesture as resetting it.
 * @param field - key addressing this control inside the card's form.
 * @param path - path of the field inside the namespace section.
 * @returns the field's conversion spec.
 */
export function pathTextField(field: string, path: readonly string[]): PathFieldSpec {
  return {
    field,
    path,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    }
  }
}

/**
 * A whole-number field. An empty draft clears the field; any other draft that
 * is not a finite number blocks the save.
 * @param field - key addressing this control inside the card's form.
 * @param path - path of the field inside the namespace section.
 * @returns the field's conversion spec.
 */
export function pathNumberField(field: string, path: readonly string[]): PathFieldSpec {
  return {
    field,
    path,
    format: (value) => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    }
  }
}

/**
 * Draft text a boolean field renders while the section carries no value.
 *
 * A missing boolean is not "unknown": `src/index.ts` declares
 * `systemOne.enabled` with `default(true)` and reads it back through
 * `liveValue(section.enabled, true)`, so an absent value means ENABLED. Rendering
 * an absent boolean as the empty string would show a disabled switch for a gate
 * that is actually running, so the draft is seeded with the declared default.
 */
const ABSENT_BOOLEAN_TEXT = 'true'

/**
 * A boolean field, staged as the `'true'`/`'false'` draft the card's switch
 * renders. An empty draft clears the field (re-inheriting the declared
 * default); any other draft that is not one of those two words blocks the save.
 * @param field - key addressing this control inside the card's form.
 * @param path - path of the field inside the namespace section.
 * @returns the field's conversion spec.
 */
export function pathBooleanField(field: string, path: readonly string[]): PathFieldSpec {
  return {
    field,
    path,
    format: (value) => (typeof value === 'boolean' ? String(value) : ABSENT_BOOLEAN_TEXT),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (trimmed === 'true') return { kind: 'set', value: true }
      if (trimmed === 'false') return { kind: 'set', value: false }
      return undefined
    }
  }
}

/**
 * Draft text for a field the section may not carry, given the default
 * `src/index.ts` declares for it. A missing value is not "unknown": the schema
 * declares one, so showing an empty control would misreport the running
 * configuration — the same reasoning as {@link ABSENT_BOOLEAN_TEXT}.
 */
function declaredDefaultText(declaredDefault: string): string {
  return declaredDefault
}

/**
 * A field restricted to a closed set of strings, rendered with the declared
 * default when the section carries none. An empty draft clears the field; any
 * other draft outside the set blocks the save rather than being dropped, so a
 * typo can never silently reconfigure the gate.
 * @param field - key addressing this control inside the card's form.
 * @param path - path of the field inside the namespace section.
 * @param allowed - the values the field accepts, in contract order.
 * @param declaredDefault - the value `src/index.ts` declares, shown while absent.
 * @returns the field's conversion spec.
 */
export function pathChoiceField(
  field: string,
  path: readonly string[],
  allowed: readonly string[],
  declaredDefault: string
): PathFieldSpec {
  if (!allowed.includes(declaredDefault)) {
    throw new Error(`dsh-gitmemo settings field ${field}: default ${declaredDefault} is not an accepted value`)
  }
  return {
    field,
    path,
    format: (value) => (typeof value === 'string' && allowed.includes(value) ? value : declaredDefaultText(declaredDefault)),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return allowed.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
    }
  }
}

/**
 * A numeric field bounded to a range, rendered with the declared default when
 * the section carries none. The bound is enforced here, not by the control, so
 * an out-of-range draft blocks the save instead of reaching the plane.
 * @param field - key addressing this control inside the card's form.
 * @param path - path of the field inside the namespace section.
 * @param bounds - inclusive range, and the declared default shown while absent.
 * @returns the field's conversion spec.
 */
export function pathBoundedNumberField(
  field: string,
  path: readonly string[],
  bounds: { min: number; max: number; declaredDefault: string }
): PathFieldSpec {
  return {
    field,
    path,
    format: (value) => (typeof value === 'number' ? String(value) : declaredDefaultText(bounds.declaredDefault)),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) return undefined
      return parsed >= bounds.min && parsed <= bounds.max ? { kind: 'set', value: parsed } : undefined
    }
  }
}
