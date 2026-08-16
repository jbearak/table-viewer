import { describe, it, expect } from 'vitest';
import { parse_http_external_url } from '../external-url';

describe('parse_http_external_url', () => {
    it('accepts plain http and https URLs, normalized', () => {
        expect(parse_http_external_url('https://example.com')).toBe('https://example.com/');
        expect(parse_http_external_url('http://example.com/a?b=1#c')).toBe('http://example.com/a?b=1#c');
        expect(parse_http_external_url('  https://example.com  ')).toBe('https://example.com/');
    });

    it('rejects every non-http(s) scheme', () => {
        for (const bad of [
            'file:///etc/passwd',
            'javascript:alert(1)',
            'vbscript:x',
            'data:text/html,hi',
            'ftp://example.com',
            'mailto:a@example.com',
            'HTTPS://example.com'.replace('HTTPS', 'httpss'),
        ]) {
            expect(parse_http_external_url(bad)).toBeNull();
        }
    });

    it('is case-insensitive on the scheme (URL normalizes it)', () => {
        expect(parse_http_external_url('HTTPS://example.com')).toBe('https://example.com/');
    });

    it('rejects non-strings, empty, malformed, and oversized values', () => {
        expect(parse_http_external_url(null)).toBeNull();
        expect(parse_http_external_url(42)).toBeNull();
        expect(parse_http_external_url({ toString: () => 'https://x.com' })).toBeNull();
        expect(parse_http_external_url('')).toBeNull();
        expect(parse_http_external_url('   ')).toBeNull();
        expect(parse_http_external_url('not a url')).toBeNull();
        expect(parse_http_external_url('https://example.com/' + 'a'.repeat(8 * 1024))).toBeNull();
    });

    it('rejects embedded control characters', () => {
        expect(parse_http_external_url('https://exam\x00ple.com')).toBeNull();
        expect(parse_http_external_url('https://example.com/\x1fpath')).toBeNull();
        expect(parse_http_external_url('https://example.com/\x7f')).toBeNull();
        expect(parse_http_external_url('https://example.com/a\nb')).toBeNull();
    });
});
