import { useRef, useCallback, useEffect } from 'react';
import type { PerFileState } from '../types';

declare function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

export const vscode_api = acquireVsCodeApi();

const DEBOUNCE_MS = 150;

export function use_state_sync(
    current_state: React.MutableRefObject<PerFileState>
) {
    const timer_ref = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (timer_ref.current) {
                clearTimeout(timer_ref.current);
            }
        };
    }, []);

    const persist = useCallback(() => {
        vscode_api.postMessage({
            type: 'stateChanged',
            state: current_state.current,
        });
    }, [current_state]);

    const persist_debounced = useCallback(() => {
        if (timer_ref.current) {
            clearTimeout(timer_ref.current);
        }
        timer_ref.current = setTimeout(persist, DEBOUNCE_MS);
    }, [persist]);

    const persist_immediate = useCallback(() => {
        if (timer_ref.current) {
            clearTimeout(timer_ref.current);
            timer_ref.current = null;
        }
        persist();
    }, [persist]);

    return { persist_debounced, persist_immediate };
}
