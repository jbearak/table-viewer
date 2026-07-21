import type { DataSource } from './data-source/interface';

export interface PhysicalSourceObservation {
    readonly fingerprint: string;
    readonly digest: string;
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
