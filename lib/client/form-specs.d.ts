/**
 * The staged settings form's pure field vocabulary: how one section field
 * converts between its stored value and the draft text the card renders.
 *
 * Deliberately a plain TypeScript module with no React, DOM or browser import:
 * the card needs it and so do the unit tests, which cannot import the browser
 * bundle. The host tsconfig compiles plain `.ts` files under `src`, so this is
 * both inlined into the client bundle and emitted for the tests to import.
 */
import type { SettingsFieldWrite } from '@deepseek-ai/dsh-client-ui-primitives';
/** The editable projection of this plugin's settings namespace. */
export interface GitMemoSettings {
    /** The System-one recall gate, as `src/index.ts` declares it. */
    systemOne?: {
        enabled?: boolean;
        endpoint?: string;
        model?: string;
        apiKey?: string;
        apiKeyEnv?: string;
        mode?: 'noul' | 'score';
        /** How the judge's values are used: order the page, or drop from it. */
        policy?: 'rerank' | 'filter';
        /** `filter` only: the share of a judged page that may be dropped. */
        maxDropFraction?: number;
        threshold?: number;
        scoreMin?: number;
        minKeep?: number;
        maxCandidates?: number;
        maxTaskChars?: number;
        timeoutMs?: number;
    };
}
/** How one section field converts between its stored value and its draft text. */
export interface PathFieldSpec {
    /** Key addressing this control inside the card's form. */
    field: string;
    /** Path inside the namespace section this control edits. */
    path: readonly string[];
    /** Render a stored value as draft text; the empty string when the section carries none. */
    format: (value: unknown) => string;
    /** The write this draft text stages, or undefined when the text is not a value this field accepts. */
    parse: (text: string) => SettingsFieldWrite | undefined;
}
/**
 * A free-text field. An empty draft clears the field, so emptying the control
 * and saving is the same gesture as resetting it.
 * @param field - key addressing this control inside the card's form.
 * @param path - path of the field inside the namespace section.
 * @returns the field's conversion spec.
 */
export declare function pathTextField(field: string, path: readonly string[]): PathFieldSpec;
/**
 * A whole-number field. An empty draft clears the field; any other draft that
 * is not a finite number blocks the save.
 * @param field - key addressing this control inside the card's form.
 * @param path - path of the field inside the namespace section.
 * @returns the field's conversion spec.
 */
export declare function pathNumberField(field: string, path: readonly string[]): PathFieldSpec;
/**
 * A boolean field, staged as the `'true'`/`'false'` draft the card's switch
 * renders. An empty draft clears the field (re-inheriting the declared
 * default); any other draft that is not one of those two words blocks the save.
 * @param field - key addressing this control inside the card's form.
 * @param path - path of the field inside the namespace section.
 * @returns the field's conversion spec.
 */
export declare function pathBooleanField(field: string, path: readonly string[]): PathFieldSpec;
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
export declare function pathChoiceField(field: string, path: readonly string[], allowed: readonly string[], declaredDefault: string): PathFieldSpec;
/**
 * A numeric field bounded to a range, rendered with the declared default when
 * the section carries none. The bound is enforced here, not by the control, so
 * an out-of-range draft blocks the save instead of reaching the plane.
 * @param field - key addressing this control inside the card's form.
 * @param path - path of the field inside the namespace section.
 * @param bounds - inclusive range, and the declared default shown while absent.
 * @returns the field's conversion spec.
 */
export declare function pathBoundedNumberField(field: string, path: readonly string[], bounds: {
    min: number;
    max: number;
    declaredDefault: string;
}): PathFieldSpec;
