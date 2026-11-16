import type { DataSource } from './data-source/interface';

import type { XlsxStructuralObservation } from './xlsx-structural-observation';

export interface PhysicalSourceObservation {
    readonly fingerprint: string;
    readonly digest: string;
    /** Byte length of the bytes `digest` covers, for the Structural Basis. */
    readonly byteLength?: number;
    /**
     * An editable `.xlsx` source's per-part digests and structural support
     * scan, taken from the bytes `digest` covers while structural editing
     * is enabled: once per source generation, so the snapshot capability and
     * every basis check read one answer.
     */
    readonly xlsxStructure?: XlsxStructuralObservation;
    /** A file-backed source was content-digested through its own descriptor and
     * bracketed by descriptor/path identity checks during construction. */
    readonly verification?: 'bracketedDigest';
    readonly comparisonFingerprint?: string;
    readonly comparisonDigest?: string;
}

type OwnershipState = 'owned' | 'transferring' | 'transferred' | 'disposed';

export type SourceCandidateInstaller = (
    source: DataSource,
    confirm_transfer: () => void,
) => void;

/**
 * Owns a freshly built source until the controller either transfers it into a
 * panel or disposes the unadopted candidate. Physical observations are captured
 * with the source so verification and authority commit use the same build.
 */
export class SourceCandidate {
    readonly observation: Readonly<PhysicalSourceObservation>;
    private state: OwnershipState = 'owned';

    constructor(
        private readonly source: DataSource,
        observation: PhysicalSourceObservation,
    ) {
        this.observation = Object.freeze({ ...observation });
    }

    borrow(): DataSource {
        if (this.state !== 'owned') {
            throw new Error(`Cannot borrow a ${this.state} source candidate.`);
        }
        return this.source;
    }

    take(): DataSource {
        if (this.state !== 'owned') {
            throw new Error(`Cannot take a ${this.state} source candidate.`);
        }
        this.state = 'transferred';
        return this.source;
    }

    /**
     * Runs installation as one ownership operation. The installer must call the
     * confirmation callback immediately after the destination has accepted and
     * taken responsibility for the source. A refusal or throw before confirmation
     * restores candidate ownership; a throw after confirmation leaves ownership
     * transferred to the installed destination.
     */
    transfer_to(installer: SourceCandidateInstaller): boolean {
        if (this.state !== 'owned') {
            throw new Error(`Cannot transfer a ${this.state} source candidate.`);
        }
        this.state = 'transferring';
        try {
            installer(this.source, () => {
                if (this.state !== 'transferring') {
                    throw new Error('The source candidate transfer was already confirmed.');
                }
                this.state = 'transferred';
            });
        } catch (error) {
            if (this.state === 'transferring') this.state = 'owned';
            throw error;
        }
        if (this.state === 'transferring') {
            this.state = 'owned';
            return false;
        }
        return true;
    }

    dispose(): void {
        if (this.state !== 'owned') return;
        // Relinquish ownership before close so a throwing close cannot leave the
        // candidate ambiguously owned or cause a later cleanup to close twice.
        this.state = 'disposed';
        this.source.close();
    }
}

/**
 * Whether two observations describe the same bytes.
 *
 * A request that captured an observation is still current while the panel
 * holds one equal to it. The panel can install a new observation object for
 * bytes it already holds: a refresh that finds the file as it was commits a
 * stage with the same digest and installs its candidate's observation, so
 * comparing by identity would call an unchanged file changed.
 *
 * `xlsxStructure` is compared by presence. Its content is derived from the
 * bytes `digest` covers, so equal digests give equal scans; but it is taken
 * only while structural editing is enabled, so a source rebuilt after that
 * setting changed can differ in having one, and is then not the same.
 */
export function same_physical_observation(
    left: PhysicalSourceObservation | undefined,
    right: PhysicalSourceObservation | undefined,
): boolean {
    if (left === right) return true;
    if (left === undefined || right === undefined) return false;
    return left.fingerprint === right.fingerprint
        && left.digest === right.digest
        && left.byteLength === right.byteLength
        && left.verification === right.verification
        && left.comparisonFingerprint === right.comparisonFingerprint
        && left.comparisonDigest === right.comparisonDigest
        && (left.xlsxStructure === undefined) === (right.xlsxStructure === undefined);
}
