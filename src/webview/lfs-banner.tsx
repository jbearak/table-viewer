import React from 'react';
import type { UnresolvedLfsObject } from '../viewer-snapshot';

export interface LfsBannerProps {
    readonly unresolved: UnresolvedLfsObject;
    readonly on_resolve: () => void;
    /** A resolve is running. The button stays mounted and disabled rather than
     *  being swapped for text: a download can take a while, and a control that
     *  vanishes mid-operation reads as the click having failed. */
    readonly resolving: boolean;
}

/** `40 MB`, matching how the object's size is quoted elsewhere in a Git LFS
 *  workflow. Decimal units deliberately: git-lfs itself reports decimal. */
function format_size(bytes: number): string {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit += 1;
    }
    return unit === 0
        ? `${value.toLocaleString()} ${units[unit]}`
        : `${(Math.round(value * 10) / 10).toLocaleString()} ${units[unit]}`;
}

/** What the user is missing, said in terms of what they can see. The two sides
 *  are genuinely different situations, not one message with a word swapped. */
function headline(side: UnresolvedLfsObject['side']): string {
    return side === 'file'
        ? 'This file is stored in Git LFS and its contents have not been downloaded.'
        : 'The version being compared against is stored in Git LFS and has not been downloaded.';
}

/**
 * The second line, and the one place the size has to be described carefully.
 *
 * `size` is the *stored object's* length, not the placeholder's — a pointer
 * file is a fixed ~130 bytes whatever it points at. Calling it "the 733.5 KB
 * placeholder" was simply false, and misleading in the specific way that
 * matters here: it made the number look like a description of the useless file
 * on disk rather than of the download the button is offering to perform.
 */
function detail(side: UnresolvedLfsObject['side'], size: number): string {
    return side === 'file'
        ? `The grid is empty until the ${format_size(size)} of data behind it is downloaded.`
        : `Differences are not shown until the ${format_size(size)} of data behind the other version is downloaded.`;
}

/**
 * Why a resolve did not work, in terms of the user's next action. A missing
 * git-lfs is the one case where pressing the button again is pointless, so it
 * says so instead of inviting a retry.
 */
function failure_copy(failure: NonNullable<UnresolvedLfsObject['failure']>): string {
    switch (failure.reason) {
        case 'lfsNotInstalled':
            return 'Git LFS is not installed, so the contents cannot be downloaded from here. Install git-lfs and reopen the file.';
        case 'notARepository':
            return 'This file is not inside a Git repository, so there is nowhere to download the contents from.';
        case 'objectMissing':
            return 'The stored contents are missing from Git LFS, so there is nothing to download. Whoever committed this file may not have pushed its contents.';
        case 'filtersNotConfigured':
            return 'Git LFS is not set up in this repository, so the contents were not downloaded. Run “git lfs install” in it, then try again.';
        case 'failed':
            return failure.detail === undefined
                ? 'Downloading the contents failed. Check your connection and credentials, then try again.'
                : `Downloading the contents failed: ${failure.detail}`;
    }
}

/**
 * The unresolved-LFS notice, and the one action that fixes it.
 *
 * Rendered in the grid rather than shown as a host notification, and that is
 * the deliberate part: a toast is gone a few seconds after the user has
 * finished reading the empty grid it was explaining, leaving no way back to the
 * button. This states the situation for as long as it is true. It borrows
 * `.truncation-banner`'s layout and neutral info colours for the same reason
 * that banner uses them — nothing is broken, some data just is not here yet.
 */
export function LfsBanner({
    unresolved,
    on_resolve,
    resolving,
}: LfsBannerProps): React.JSX.Element {
    const { side, size, resolvable, failure } = unresolved;
    // A retry is worth offering for anything except a git-lfs that is not
    // installed, which no number of clicks will change.
    // Retry anything that another attempt could plausibly fix. Not a missing
    // git-lfs, and not a missing object: the bytes do not exist to be fetched,
    // so a button here would be the "does nothing" trap this banner replaces.
    const retryable = failure === undefined
        || failure.reason === 'failed'
        || failure.reason === 'filtersNotConfigured';
    return (
        <div className="truncation-banner lfs-banner">
            <div className="truncation-banner-copy">
                <div>{headline(side)}</div>
                <div className="truncation-banner-detail">
                    {failure ? failure_copy(failure) : detail(side, size)}
                </div>
            </div>
            {resolvable && retryable && (
                <div className="truncation-banner-actions">
                    <button
                        type="button"
                        className="truncation-load-action"
                        disabled={resolving}
                        title={side === 'file'
                            ? 'Download this file’s contents from Git LFS.'
                            : 'Download the compared version’s contents from Git LFS.'}
                        onClick={on_resolve}
                    >
                        {resolving
                            ? 'Downloading…'
                            : failure
                            ? 'Try again'
                            : 'Download contents'}
                    </button>
                </div>
            )}
        </div>
    );
}
