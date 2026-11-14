// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PendingChangeNotices } from '../webview/pending-change-notices-view';
import type { PendingChangeNotice, PendingChangeNoticeFormula } from '../webview/pending-change-notices';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
});

function formula(row: number): PendingChangeNoticeFormula {
    return {
        location: `Total, row ${row}`,
        formula: '=#REF!',
        goTo: { label: 'Go to cell', intent: { kind: 'goToCell', sheetIndex: 0, row, column: 0 } },
    };
}

// A Save refusal has no dismissal key, so its list keeps its React key while
// its content changes.
function refusal(rows: readonly number[]): PendingChangeNotice {
    const collapsed = rows.length > 3;
    return {
        kind: 'saveRefusal',
        role: 'alert',
        severity: 'refusal',
        label: 'Changes Save will refuse',
        sentences: ['Save will refuse these changes.'],
        formulas: {
            items: rows.map(formula),
            total: rows.length,
            collapsed,
            disclosureLabel: `Show ${rows.length} formulas`,
        },
        actions: [],
    };
}

function render(notice: PendingChangeNotice): void {
    act(() => root!.render(React.createElement(PendingChangeNotices, {
        notices: [notice],
        status: '',
        on_intent: () => {},
    })));
}

describe('PendingChangeNotices', () => {
    it('shows a formula list that was collapsed once it is short enough to show inline', () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        render(refusal([1, 2, 3, 4]));
        expect(container.querySelector('.pending-change-formulas')).toBeNull();
        expect(container.querySelector('.pending-change-disclosure')?.textContent).toBe('Show 4 formulas');

        render(refusal([1, 2]));
        expect(container.querySelector('.pending-change-disclosure')).toBeNull();
        expect([...container.querySelectorAll('.pending-change-formulas li')].map((item) => item.querySelector(
            '.pending-change-formula-location',
        )?.textContent)).toEqual(['Total, row 1', 'Total, row 2']);
    });

    it('keeps an opened list open while it lists the same formulas under reworded sentences', () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        // Going to a cell on Summary rewords the first sentence, and with it the dismissal key.
        const notice = (where: string): PendingChangeNotice => ({
            ...refusal([2, 3, 4, 5]),
            kind: 'deletedReferences',
            sentences: [`4 formulas use column Price${where}, which you deleted.`],
            dismissKey: `deleted:${where}`,
        });
        render(notice(''));
        act(() => (container!.querySelector('.pending-change-disclosure') as HTMLButtonElement).click());
        expect(container.querySelectorAll('.pending-change-formulas li')).toHaveLength(4);

        render(notice(' on Data'));
        expect(container.querySelectorAll('.pending-change-formulas li')).toHaveLength(4);
        expect(container.querySelector('.pending-change-disclosure')?.textContent).toBe('Hide formulas');
    });
});
