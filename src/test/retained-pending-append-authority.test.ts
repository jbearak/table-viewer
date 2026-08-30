import { describe, expect, it } from 'vitest';
import { RetainedPendingAppendAuthorityStore } from '../retained-pending-append-authority';

describe('RetainedPendingAppendAuthorityStore', () => {
    it('bounds thousands of distinct row-format capabilities by aggregate bytes', () => {
        const max_bytes = 64 * 1024;
        const store = new RetainedPendingAppendAuthorityStore(max_bytes);

        for (let index = 0; index < 10_000; index += 1) {
            const template = Object.freeze({
                id: `format-${index}`,
                format: Object.freeze({
                    kind: 'xlsx' as const,
                    templateSourceRow: null,
                    styleFingerprint: `style-${index}-${'x'.repeat(80)}`,
                    cellStyleIndexes: Object.freeze([index]),
                }),
            });
            store.remember('sheet', `row-${index}`, {
                formatTemplate: template,
                formatTemplateId: template.id,
                sourceGeneration: 1,
            });
        }

        expect(store.byte_count).toBeLessThanOrEqual(max_bytes);
        expect(store.row_count).toBeGreaterThan(0);
        expect(store.row_count).toBeLessThan(10_000);
        expect(store.get('sheet', 'row-0')).toBeUndefined();
        expect(store.get('sheet', 'row-9999')).toMatchObject({
            formatTemplateId: 'format-9999',
            formatTemplate: { id: 'format-9999' },
        });
    });

    it('releases byte accounting when history drops a retained row', () => {
        const store = new RetainedPendingAppendAuthorityStore(64 * 1024);
        const formatTemplate = Object.freeze({
            id: 'format',
            format: Object.freeze({ kind: 'none' as const }),
        });
        store.remember('sheet', 'row', {
            formatTemplate,
            formatTemplateId: formatTemplate.id,
            sourceGeneration: 1,
        });
        expect(store.byte_count).toBeGreaterThan(0);

        store.forget('sheet', 'row');

        expect(store.byte_count).toBe(0);
        expect(store.row_count).toBe(0);
    });
});
