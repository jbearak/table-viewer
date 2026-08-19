import { describe, it, expect } from 'vitest';
import { get_attr, remove_attr } from '../ooxml-xml';

describe('get_attr', () => {
    it('reads a double-quoted attribute', () => {
        expect(get_attr('<c r="A1">', 'r')).toBe('A1');
    });

    it('reads a single-quoted attribute', () => {
        expect(get_attr("<c r='A1'>", 'r')).toBe('A1');
    });

    it('allows XML whitespace around the equals sign', () => {
        expect(get_attr('<c r = "A1">', 'r')).toBe('A1');
    });

    it('ignores attribute-shaped text inside a double-quoted value', () => {
        expect(get_attr('<c note="text containing r=\'Z99\'" r="A1">', 'r')).toBe('A1');
    });

    it('ignores attribute-shaped text inside a single-quoted value', () => {
        expect(get_attr('<c note=\'has r="Z99" inside\' r="A1">', 'r')).toBe('A1');
    });

    it('recognizes any XML whitespace after the element name', () => {
        expect(get_attr('<c\nr="A1"\ns="7">', 'r')).toBe('A1');
    });

    it('decodes entities in the attribute value', () => {
        expect(get_attr('<c r="A&#49;">', 'r')).toBe('A1');
    });

    it('does not confuse a prefixed attribute with an unqualified one', () => {
        expect(get_attr('<c vendor:r="A1">', 'r')).toBeNull();
    });
});

describe('remove_attr', () => {
    it('removes the exact attribute in either quote form', () => {
        expect(remove_attr('<row vendor:spans="9:9" spans = \'1:1\' r="1">', 'spans'))
            .toBe('<row vendor:spans="9:9" r="1">');
    });
});
