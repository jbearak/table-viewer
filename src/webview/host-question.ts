/**
 * One keyed question to the host, for the two formula questions the webview
 * asks about Pending Changes: the Save warnings' formula review and the
 * conflict notice's formula impact. Both have the same shape: an answer is
 * worth asking for again only when the state it describes changes, which the
 * caller names with a `key`; only the latest request's answer counts; and an
 * answer from before a reload (another `sourceGeneration`) never counts.
 *
 * The last answer stays available after the key moves on, marked not
 * current, so a caller can keep showing it while the next is computed or
 * hide it at once, as its content requires.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostMessage, WebviewMessage } from '../types';
import { host_bridge } from './host-bridge';

type AnswerMessage = Extract<HostMessage, { type: 'formulaDivergence' | 'formulaImpact' }>;

export interface HostQuestion<Answer> {
    /** The latest answer, for the current key or an earlier one; cleared when the key is undefined. */
    readonly answer: Answer | undefined;
    /** Whether `answer` describes the current key. */
    readonly current: boolean;
    /** Whether the answer for the current key is still out. */
    readonly pending: boolean;
    /** Forget the current key's answer and ask again. */
    retry(): void;
}

let request_sequence = 0;

export function use_host_question<Type extends AnswerMessage['type'], Answer>(options: {
    /** The answer message's type. */
    readonly type: Type;
    /** What the answer depends on; undefined asks nothing and clears the answer. */
    readonly key: string | undefined;
    /** The request for the current key, built when it is sent. */
    readonly ask: (requestId: string, sourceGeneration: number) => WebviewMessage;
    readonly read: (message: Extract<HostMessage, { type: Type }>) => Answer;
    readonly sourceGeneration: () => number;
    /**
     * Wait this long after the key last changed before asking, so a burst of
     * gestures asks once. The host also drops a run a newer request
     * supersedes.
     */
    readonly delayMs?: number;
}): HostQuestion<Answer> {
    const { type, key, delayMs = 0 } = options;
    const latest = useRef(options);
    latest.current = options;
    const [answer, set_answer] = useState<{ readonly key: string; readonly value: Answer }>();
    const answered_key = useRef<string>();
    answered_key.current = answer?.key;
    const request = useRef<{ readonly requestId: string; readonly key: string; readonly sourceGeneration: number }>();
    const [attempt, set_attempt] = useState(0);

    useEffect(() => {
        if (key === undefined) {
            request.current = undefined;
            set_answer(undefined);
            return;
        }
        if (answered_key.current === key) {
            request.current = undefined;
            return;
        }
        const send = () => {
            const requestId = `${type}:${++request_sequence}`;
            const sourceGeneration = latest.current.sourceGeneration();
            request.current = { requestId, key, sourceGeneration };
            host_bridge.postMessage(latest.current.ask(requestId, sourceGeneration));
        };
        if (delayMs <= 0) {
            send();
            return;
        }
        const timer = setTimeout(send, delayMs);
        return () => clearTimeout(timer);
    }, [type, key, attempt, delayMs]);

    useEffect(() => {
        const on_message = (event: MessageEvent) => {
            const message = event.data as HostMessage;
            if (message.type !== type) return;
            const active = request.current;
            const answered = message as AnswerMessage;
            if (active === undefined || active.requestId !== answered.requestId) return;
            if (answered.sourceGeneration !== active.sourceGeneration
                || answered.sourceGeneration !== latest.current.sourceGeneration()) return;
            request.current = undefined;
            set_answer({ key: active.key, value: latest.current.read(answered as Extract<HostMessage, { type: Type }>) });
        };
        window.addEventListener('message', on_message);
        return () => window.removeEventListener('message', on_message);
    }, [type]);

    const retry = useCallback(() => {
        answered_key.current = undefined;
        set_answer(undefined);
        set_attempt((value) => value + 1);
    }, []);

    const current = key !== undefined && answer?.key === key;
    return {
        answer: key === undefined ? undefined : answer?.value,
        current,
        pending: key !== undefined && !current,
        retry,
    };
}
