import React, { useEffect, useRef, useState } from 'react';

interface CellEditorProps {
    value: string;
    on_confirm: (value: string, advance: 'down' | 'right' | 'none') => void;
    on_cancel: () => void;
}

export function CellEditor({
    value,
    on_confirm,
    on_cancel,
}: CellEditorProps): React.JSX.Element {
    const [current_value, set_current_value] = useState(value);
    const input_ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
    const [is_multiline, set_is_multiline] = useState(value.includes('\n'));
    const mounted_ref = useRef(false);

    useEffect(() => {
        const el = input_ref.current;
        if (el) {
            el.focus();
            if (mounted_ref.current) {
                // Switching to textarea — place cursor at end
                const len = el.value.length;
                el.setSelectionRange(len, len);
            } else {
                // Initial mount — select all for easy replacement
                el.select();
                mounted_ref.current = true;
            }
        }
    }, [is_multiline]);

    const handle_key_down = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        // Read the live DOM value so we get any imperatively-set value
        const live_value = e.currentTarget.value;

        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            on_cancel();
            return;
        }

        if (e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            on_confirm(live_value, 'right');
            return;
        }

        if (e.key === 'Enter' && (e.shiftKey || e.altKey)) {
            e.preventDefault();
            e.stopPropagation();
            const new_value = live_value + '\n';
            set_current_value(new_value);
            set_is_multiline(true);
            return;
        }

        if (e.key === 'Enter' && !is_multiline) {
            e.preventDefault();
            e.stopPropagation();
            on_confirm(live_value, 'down');
            return;
        }

        // For multiline: Ctrl/Cmd+Enter confirms
        if (e.key === 'Enter' && is_multiline && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            on_confirm(live_value, 'down');
            return;
        }

        // Allow Ctrl/Cmd+S to propagate to window-level save handler
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            return;
        }

        // Stop propagation for all other keys to prevent table keyboard handlers
        e.stopPropagation();
    };

    const shared_props = {
        className: 'cell-editor-input',
        onKeyDown: handle_key_down,
        onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set_current_value(e.target.value),
    };

    if (is_multiline) {
        return (
            <textarea
                ref={input_ref as React.RefObject<HTMLTextAreaElement>}
                value={current_value}
                rows={current_value.split('\n').length}
                {...shared_props}
            />
        );
    }

    return (
        <input
            ref={input_ref as React.RefObject<HTMLInputElement>}
            type="text"
            value={current_value}
            {...shared_props}
        />
    );
}
