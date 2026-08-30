import { describe, expect, it } from 'vitest';
import { AppendAdmissionTemplateAuthorityStore } from '../append-admission-template-authority';

const template = (index: number) => Object.freeze({
    id: `template-${index}`,
    format: Object.freeze({
        kind: 'xlsx' as const,
        templateSourceRow: null,
        styleFingerprint: `style-${index}-${'x'.repeat(80)}`,
        cellStyleIndexes: Object.freeze([index]),
    }),
});

describe('AppendAdmissionTemplateAuthorityStore', () => {
    it('bounds live-ledger accumulation across thousands of distinct templates', () => {
        const max_bytes = 64 * 1024;
        const store = new AppendAdmissionTemplateAuthorityStore(max_bytes);
        let accepted = 0;
        for (let index = 0; index < 10_000; index += 1) {
            const request_owner = `request-${index}`;
            const next = template(index);
            if (!store.reserve(request_owner, [next])) break;
            expect(store.commit(request_owner, 'ledger', [next])).toBe(true);
            accepted += 1;
        }

        expect(accepted).toBeGreaterThan(0);
        expect(accepted).toBeLessThan(10_000);
        expect(store.byte_count).toBeLessThanOrEqual(max_bytes);
        expect(store.get('ledger', `template-${accepted - 1}`)).toBeDefined();
        expect(store.get('ledger', `template-${accepted}`)).toBeUndefined();
    });

    it('releases refused reservations and whole ledgers', () => {
        const store = new AppendAdmissionTemplateAuthorityStore(64 * 1024);
        expect(store.reserve('request', [template(1)])).toBe(true);
        const reserved = store.byte_count;
        expect(reserved).toBeGreaterThan(0);
        store.forget_owner('request');
        expect(store.byte_count).toBe(0);

        expect(store.remember('ledger', template(2))).toBe(true);
        expect(store.byte_count).toBeGreaterThan(0);
        store.forget_owner('ledger');
        expect(store.byte_count).toBe(0);
    });

    it('replaces a ledger template set atomically when the aggregate cap is reached', () => {
        const original_a = template(1);
        const original_b = template(2);
        const replacement_a = Object.freeze({
            ...original_a,
            format: Object.freeze({
                ...original_a.format,
                styleFingerprint: `replacement-a-${'a'.repeat(1_000)}`,
            }),
        });
        const replacement_b = Object.freeze({
            ...original_b,
            format: Object.freeze({
                ...original_b.format,
                styleFingerprint: `replacement-b-${'b'.repeat(8_000)}`,
            }),
        });
        const store = new AppendAdmissionTemplateAuthorityStore(4_000);
        expect(store.replace('ledger', [original_a, original_b])).toBe(true);
        const bytes_before = store.byte_count;

        expect(store.replace('ledger', [replacement_a, replacement_b])).toBe(false);
        expect(store.byte_count).toBe(bytes_before);
        expect(store.get('ledger', original_a.id)).toBe(original_a);
        expect(store.get('ledger', original_b.id)).toBe(original_b);
    });
});
