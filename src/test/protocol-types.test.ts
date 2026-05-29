import { describe, it, expect } from 'vitest';
import type { HostMessage, WebviewMessage } from '../types';
import type { WorkbookMeta, RenderedCell } from '../data-source/interface';

describe('paginated protocol message shapes', () => {
    const meta: WorkbookMeta = {
        hasFormatting: false,
        sheets: [{ name: 'Sheet1', rowCount: 3, columnCount: 2, merges: [], hasFormatting: false }],
    };

    it('HostMessage carries a sheetMeta variant with generation', () => {
        const msg: HostMessage = {
            type: 'sheetMeta',
            meta,
            state: {},
            defaultTabOrientation: 'horizontal',
            generation: 1,
        };
        expect(msg.type).toBe('sheetMeta');
        if (msg.type === 'sheetMeta') {
            expect(msg.meta.sheets[0].rowCount).toBe(3);
            expect(msg.generation).toBe(1);
        }
    });

    it('HostMessage carries a metaReload variant', () => {
        const msg: HostMessage = {
            type: 'metaReload',
            meta,
            generation: 2,
        };
        expect(msg.type).toBe('metaReload');
        if (msg.type === 'metaReload') expect(msg.generation).toBe(2);
    });

    it('HostMessage carries a rowData variant addressed by sheet/start/requestId', () => {
        const cell: RenderedCell = { raw: 'a', formatted: 'a', bold: false, italic: false };
        const msg: HostMessage = {
            type: 'rowData',
            sheetIndex: 0,
            startRow: 100,
            rows: [[cell, null]],
            requestId: 'req-1',
            generation: 3,
        };
        expect(msg.type).toBe('rowData');
        if (msg.type === 'rowData') {
            expect(msg.startRow).toBe(100);
            expect(msg.rows[0][0]?.raw).toBe('a');
            expect(msg.rows[0][1]).toBeNull();
            expect(msg.requestId).toBe('req-1');
        }
    });

    it('WebviewMessage carries a requestRows variant', () => {
        const msg: WebviewMessage = {
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 100,
            count: 50,
            requestId: 'req-1',
            generation: 3,
        };
        expect(msg.type).toBe('requestRows');
        if (msg.type === 'requestRows') {
            expect(msg.count).toBe(50);
            expect(msg.generation).toBe(3);
        }
    });

    it('legacy workbookData/reload variants remain on HostMessage during transition', () => {
        const wb: HostMessage = {
            type: 'workbookData',
            data: { hasFormatting: false, sheets: [] },
            state: {},
            defaultTabOrientation: 'horizontal',
        };
        expect(wb.type).toBe('workbookData');
    });
});
