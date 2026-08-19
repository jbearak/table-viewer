export type OoxmlRefusalCode =
    | 'namespace-prefixed-worksheet-element'
    | 'markup-compatibility-alternate-content'
    | 'foreign-worksheet-namespace'
    | 'missing-cell-reference'
    | 'invalid-cell-reference';

const REFUSAL_DESCRIPTIONS: Readonly<Record<OoxmlRefusalCode, string>> = {
    'namespace-prefixed-worksheet-element': 'namespace-prefixed cell elements',
    'markup-compatibility-alternate-content': 'markup-compatibility alternate content',
    'foreign-worksheet-namespace': 'worksheet elements in a different XML namespace',
    'missing-cell-reference': 'cells whose position is implied rather than written',
    'invalid-cell-reference': 'invalid cell references',
};

/** A worksheet shape that cannot be edited without risking silent corruption. */
export class OoxmlRefusalError extends Error {
    readonly code: OoxmlRefusalCode;
    readonly coordinate?: string;

    constructor(code: OoxmlRefusalCode, coordinate?: string) {
        super(
            `Cannot edit this worksheet: it uses ${REFUSAL_DESCRIPTIONS[code]}, `
            + 'which Table Viewer cannot edit safely. Re-saving the file in Excel '
            + 'will normally fix it.',
        );
        this.name = 'OoxmlRefusalError';
        this.code = code;
        this.coordinate = coordinate;
    }
}
