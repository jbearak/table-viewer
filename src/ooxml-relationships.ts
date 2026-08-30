/**
 * OPC relationship (`.rels`) parsing, shared by the worksheet hyperlink reader
 * (stage 1) and the hyperlink writer (stage 4). One implementation so the
 * reader and writer cannot disagree about what a relationship file says —
 * the workbook-level sheet rels in parse-xlsx.ts predate this module and keep
 * their own scan because they also resolve targets against the package root.
 */

import { get_attr } from './ooxml-xml';
import {
    direct_child_elements,
    find_first_element_by_local_name,
    opening_tag_text,
    type QualifiedElementSpan,
} from './ooxml-worksheet-scan';

export const TRANSITIONAL_PACKAGE_RELATIONSHIPS_NS
    = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const STRICT_PACKAGE_RELATIONSHIPS_NS
    = 'http://purl.oclc.org/ooxml/package/relationships';

export interface OoxmlRelationship {
    readonly type: string;
    readonly target: string;
    /** True when TargetMode="External" — the target is a URI, not a package part. */
    readonly external: boolean;
}

export interface OoxmlRelationshipElement {
    readonly name: string;
    readonly element: QualifiedElementSpan['element'];
    readonly openTag: string;
}

export interface OoxmlRelationshipsDocument {
    readonly root: QualifiedElementSpan;
    readonly rootOpenTag: string;
    readonly namespace: string;
    readonly relationships: readonly OoxmlRelationshipElement[];
}

function qname_prefix(name: string): string {
    const colon = name.indexOf(':');
    return colon === -1 ? '' : name.slice(0, colon);
}

function namespace_attribute(prefix: string): string {
    return prefix === '' ? 'xmlns' : `xmlns:${prefix}`;
}

function supported_relationships_namespace(value: string | null): value is string {
    return value === TRANSITIONAL_PACKAGE_RELATIONSHIPS_NS
        || value === STRICT_PACKAGE_RELATIONSHIPS_NS;
}

/** Locate a valid OPC Relationships root and its direct Relationship children. */
export function scan_relationships_document(
    xml: string,
): OoxmlRelationshipsDocument | undefined {
    const bytes = Buffer.from(xml, 'utf8');
    const root = find_first_element_by_local_name(bytes, 'Relationships');
    if (root === null) return undefined;
    const root_open = opening_tag_text(bytes, root.element);
    const declared_root_namespace = get_attr(
        root_open,
        namespace_attribute(qname_prefix(root.name)),
    );
    const root_namespace = declared_root_namespace
        ?? (qname_prefix(root.name) === '' ? TRANSITIONAL_PACKAGE_RELATIONSHIPS_NS : null);
    if (!supported_relationships_namespace(root_namespace)) return undefined;
    const relationships = direct_child_elements(bytes, root.element).flatMap((child) => {
        if (child.name.slice(child.name.lastIndexOf(':') + 1) !== 'Relationship') return [];
        const open = opening_tag_text(bytes, child.element);
        const attribute = namespace_attribute(qname_prefix(child.name));
        const namespace = get_attr(open, attribute)
            ?? get_attr(root_open, attribute)
            ?? (qname_prefix(child.name) === '' && qname_prefix(root.name) === ''
                ? root_namespace
                : null);
        return namespace === root_namespace ? [{
            name: child.name,
            element: child.element,
            openTag: open,
        }] : [];
    });
    return {
        root,
        rootOpenTag: root_open,
        namespace: root_namespace,
        relationships,
    };
}

/** Parse a `.rels` part into a map keyed by relationship Id. */
export function parse_relationships(xml: string): Map<string, OoxmlRelationship> {
    const rels = new Map<string, OoxmlRelationship>();
    const document = scan_relationships_document(xml);
    if (document === undefined) return rels;
    for (const relationship of document.relationships) {
        const open_tag = relationship.openTag;
        const id = get_attr(open_tag, 'Id');
        const type = get_attr(open_tag, 'Type');
        const target = get_attr(open_tag, 'Target');
        if (!id || !type || target === null) continue;
        const external = get_attr(open_tag, 'TargetMode') === 'External';
        rels.set(id, { type, target, external });
    }
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
