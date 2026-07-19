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
            sourceGeneration: 1,
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
            state: { transforms: [] },
            projectionChange: 'excelHeader',
            headerRequestId: 'header:1',
            generation: 2,
            sourceGeneration: 2,
        };
        expect(msg.type).toBe('metaReload');
        if (msg.type === 'metaReload') {
            expect(msg.generation).toBe(2);
            expect(msg.projectionChange).toBe('excelHeader');
            expect(msg.headerRequestId).toBe('header:1');
            expect(msg.state?.transforms).toEqual([]);
        }
    });

    it('HostMessage carries terminal header metadata recovery', () => {
        const msg: HostMessage = {
            type: 'metaReloadRecovery',
            meta,
            state: {},
            projectionChange: 'excelHeader',
            headerRequestId: 'header:terminal',
            generation: 8,
            sourceGeneration: 6,
            error: 'Delivery retries were exhausted.',
        };
        expect(msg.generation).toBe(8);
        expect(msg.sourceGeneration).toBe(6);
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

    it('WebviewMessage fences state snapshots by source generation', () => {
        const msg: WebviewMessage = {
            type: 'stateChanged',
            sourceGeneration: 3,
            state: {
                rowHeights: [{ 0: 44 }],
                scrollPosition: [{ top: 100, left: 20 }],
            },
        };
        expect(msg.sourceGeneration).toBe(3);
    });

    it('WebviewMessage carries a showWarning variant with a message', () => {
        const msg: WebviewMessage = {
            type: 'showWarning',
            message: 'Copied data was clipped.',
        };
        expect(msg.type).toBe('showWarning');
        if (msg.type === 'showWarning') {
            expect(msg.message).toBe('Copied data was clipped.');
        }
    });

    it('carries Excel first-row header request and result variants', () => {
        const request: WebviewMessage = {
            type: 'setExcelFirstRowHeader',
            sheetIndex: 1,
            sheetName: 'People',
            enabled: true,
            requestId: 'header:1',
            generation: 2,
            sourceGeneration: 3,
        };
        const result: HostMessage = {
            type: 'excelFirstRowHeaderError',
            requestId: 'header:1',
            error: 'The worksheet changed.',
        };
        const visibility: WebviewMessage = {
            type: 'setColumnVisibility',
            sheetIndex: 1,
            sheetName: 'People',
            state: undefined,
            sourceGeneration: 3,
        };
        expect(request.type).toBe('setExcelFirstRowHeader');
        expect(result.type).toBe('excelFirstRowHeaderError');
        expect(visibility.type).toBe('setColumnVisibility');
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
});
