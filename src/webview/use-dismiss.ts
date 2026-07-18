import { useEffect, type RefObject } from 'react';

export type DismissReason = 'outside' | 'escape';

export function use_dismiss(
    ref: RefObject<HTMLElement>,
    on_dismiss: (reason: DismissReason) => void,
): void {
    useEffect(() => {
        const on_pointer_down = (event: PointerEvent): void => {
            const element = ref.current;
            if (!element || element.contains(event.target as Node)) return;
            on_dismiss('outside');
        };
        const on_key_down = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault();
                on_dismiss('escape');
            }
        };
        document.addEventListener('pointerdown', on_pointer_down, true);
        document.addEventListener('keydown', on_key_down, true);
        return () => {
            document.removeEventListener('pointerdown', on_pointer_down, true);
            document.removeEventListener('keydown', on_key_down, true);
        };
    }, [ref, on_dismiss]);
}
