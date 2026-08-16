/**
 * OPC relationship (`.rels`) parsing, shared by the worksheet hyperlink reader
 * (stage 1) and the hyperlink writer (stage 4). One implementation so the
 * reader and writer cannot disagree about what a relationship file says —
 * the workbook-level sheet rels in parse-xlsx.ts predate this module and keep
 * their own scan because they also resolve targets against the package root.
 */

import { get_attr, iter_elements } from './ooxml-xml';

export interface OoxmlRelationship {
    readonly type: string;
    readonly target: string;
    /** True when TargetMode="External" — the target is a URI, not a package part. */
    readonly external: boolean;
}

/** Parse a `.rels` part into a map keyed by relationship Id. */
export function parse_relationships(xml: string): Map<string, OoxmlRelationship> {
    const rels = new Map<string, OoxmlRelationship>();
    iter_elements(xml, 'Relationship', (open_tag) => {
        const id = get_attr(open_tag, 'Id');
        const type = get_attr(open_tag, 'Type');
        const target = get_attr(open_tag, 'Target');
        if (!id || !type || target === null) return;
        const external = get_attr(open_tag, 'TargetMode') === 'External';
        rels.set(id, { type, target, external });
    });
    return rels;
}

/** The conventional `.rels` part path for a package part:
 *  `xl/worksheets/sheet1.xml` -> `xl/worksheets/_rels/sheet1.xml.rels`. */
export function rels_path_for_part(part_path: string): string {
    const slash = part_path.lastIndexOf('/');
    const dir = slash === -1 ? '' : part_path.slice(0, slash + 1);
    const base = slash === -1 ? part_path : part_path.slice(slash + 1);
    return `${dir}_rels/${base}.rels`;
}
