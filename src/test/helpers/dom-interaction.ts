/**
 * jsdom interaction helpers shared by the tests that drive real React UI.
 *
 * These exist because React does not see a plain `input.value = x`: it tracks
 * the last value it wrote on the DOM node, so an assignment that bypasses the
 * native setter is diffed away as "unchanged" and no onChange fires. Going
 * through the prototype setter and then dispatching the event is what makes a
 * controlled input actually update.
 *
 * Lookups query the whole document, not a container: components under test
 * portal into the body (menus, dialogs), so a container-scoped query would
 * miss them.
 */

/** A form control by id. Throws rather than returning null, so a renamed field
 *  fails at the lookup with the id in the message. */
export function field(id: string): HTMLInputElement | HTMLSelectElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`missing #${id}`);
    return element as HTMLInputElement | HTMLSelectElement;
}

/** A button by its exact text. */
export function button(label: string): HTMLButtonElement {
    const match = find_button((text) => text === label);
    if (!match) throw new Error(`missing "${label}" button`);
    return match;
}

/** The first button whose text satisfies `predicate`, or undefined. Use when
 *  the label carries a variable part ("Hyperlink…" vs "Edit hyperlink…"). */
export function find_button(
    predicate: (text: string) => boolean,
): HTMLButtonElement | undefined {
    return Array.from(document.querySelectorAll('button'))
        .find((candidate) => predicate(candidate.textContent ?? ''));
}

/**
 * Set a controlled input's value the way a user would. Call inside `act`.
 */
export function set_input_value(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}
