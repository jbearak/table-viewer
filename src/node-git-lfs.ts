/**
 * The Node-backed `GitLfsPort`, shared by both shells the way
 * `node-file-refresh-watcher.ts` is: the extension and the desktop app both
 * run on Node, so there is one implementation and no `vscode` import here.
 *
 * This is the only place in `src/` that spawns a child process, and it is
 * deliberately narrow about it. `git` is invoked with a fixed argv and no
 * shell, so nothing in a file path can be read as a command; the working
 * directory is the resource's own directory, which is what makes git discover
 * the right repository and the right `.gitattributes` filter configuration;
 * and every invocation is bounded in both time and output so an
 * authentication prompt or a wrong-sized object cannot hang or exhaust the
 * viewer.
 *
 * Delegating to the `git-lfs` CLI rather than speaking the LFS batch API
 * ourselves is the point. Resolving an object requires the remote URL, the
 * user's credential helper, their ssh configuration, their proxy, and any
 * enterprise auth in front of the LFS endpoint. git-lfs already has all of it
 * configured on a machine where LFS works at all; a viewer reimplementing that
 * stack would be a large, security-sensitive surface that is wrong in a
 * different way on every network.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
    GitLfsFailureReason,
    GitLfsPort,
    GitLfsResolveOutcome,
    GitLfsSmudgeOutcome,
} from './host-ports';
import { parse_git_lfs_pointer, type GitLfsPointer } from './git-lfs-pointer';
import type { ResourceUriLike } from './resource-identity';

/** Generous enough for a large object over a slow link, short enough that a
 *  git-lfs waiting on a credential prompt it cannot show does not wedge the
 *  button forever. */
const RESOLVE_TIMEOUT_MS = 120_000;
/** How much stderr to keep for the banner. git-lfs's useful first line is far
 *  shorter; the rest is progress noise. */
const MAX_DETAIL_LENGTH = 200;
/** Slack over the pointer's stated size, for the smudge output cap. An honest
 *  object is exactly `size` bytes; the margin only avoids failing a stream
 *  that is correct but arrives with a trailing chunk boundary. */
const SMUDGE_SIZE_SLACK = 4096;

/** A pointer whose object exceeds this is refused before spawning: the bytes
 *  are buffered in memory for the comparison, and a multi-gigabyte media
 *  object is not something to hold there. */
const MAX_SMUDGE_BYTES = 512 * 1024 * 1024;

interface CommandResult {
    readonly code: number | null;
    readonly stdout: Uint8Array;
    readonly stderr: string;
    /** The process produced more stdout than the caller allowed. */
    readonly overflowed: boolean;
    /** `git` itself could not be executed (ENOENT on PATH, EACCES, …). */
    readonly spawnFailed: boolean;
}

interface RunOptions {
    readonly cwd: string;
    readonly args: readonly string[];
    /** Bytes fed to stdin, or undefined to close it immediately. Closing it is
     *  what keeps a subcommand that would otherwise read from a terminal from
     *  blocking. */
    readonly stdin?: Uint8Array;
    /** Cap on retained stdout; beyond it the child is killed. Zero means the
     *  caller wants no stdout at all. */
    readonly maxStdout: number;
}

/**
 * Run `git` and resolve with its outcome, never rejecting.
 *
 * Bounded on every axis a hung or hostile child could exploit: a timeout that
 * escalates to SIGKILL, a stdout cap that kills rather than buffers without
 * limit, and stdin always closed so a subcommand expecting a terminal cannot
 * block forever. A spawn failure is reported in the result rather than thrown,
 * so "git is missing" and "git said no" are handled on the same path.
 */
function run_git({ cwd, args, stdin, maxStdout }: RunOptions): Promise<CommandResult> {
    return new Promise((resolve) => {
        const child = spawn('git', [...args], {
            cwd,
            // No shell: argv is passed through verbatim, so a path containing
            // shell metacharacters is data rather than syntax.
            shell: false,
            windowsHide: true,
            env: {
                ...process.env,
                // Fail rather than block when git wants credentials it has no
                // way to ask for: this runs with no terminal attached, so an
                // interactive prompt would just sit there until the timeout.
                GIT_TERMINAL_PROMPT: '0',
                GCM_INTERACTIVE: 'never',
            },
        });
        const stdout_chunks: Buffer[] = [];
        let stdout_length = 0;
        let stderr = '';
        let overflowed = false;
        let spawn_failed = false;
        let settled = false;

        const timeout = setTimeout(() => {
            // SIGKILL rather than SIGTERM: the process is already past a
            // deadline generous enough that a well-behaved one would have
            // exited, and git-lfs spawns children of its own.
            child.kill('SIGKILL');
        }, RESOLVE_TIMEOUT_MS);
        timeout.unref?.();

        const settle = (result: CommandResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };

        child.stdout?.on('data', (chunk: Buffer) => {
            if (overflowed) return;
            stdout_length += chunk.byteLength;
            if (stdout_length > maxStdout) {
                overflowed = true;
                stdout_chunks.length = 0;
                child.kill('SIGKILL');
                return;
            }
            stdout_chunks.push(chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < MAX_DETAIL_LENGTH * 4) stderr += chunk.toString('utf8');
        });
        // A stdin write can fail with EPIPE when the child exits early; that
        // is reported by the exit code, not by throwing out of the port.
        child.stdin?.on('error', () => {});
        child.on('error', () => {
            spawn_failed = true;
            settle({
                code: null,
                stdout: new Uint8Array(0),
                stderr,
                overflowed,
                spawnFailed: true,
            });
        });
        child.on('close', (code) => {
            settle({
                code,
                stdout: overflowed
                    ? new Uint8Array(0)
                    : new Uint8Array(Buffer.concat(stdout_chunks)),
                stderr,
                overflowed,
                spawnFailed: spawn_failed,
            });
        });

        if (stdin) child.stdin?.end(stdin);
        else child.stdin?.end();
    });
}

/**
 * One line of git-lfs's stderr, fit to show in the banner.
 *
 * Real git-lfs output is messier than it looks from the outside, and every
 * clause here answers something observed from the actual CLI:
 *
 * - It echoes the pointer stanza itself to stderr, so `version …`/`oid …`/
 *   `size …` lines have to be skipped or the "reason" is just the pointer.
 * - Progress lines (`Downloading data.csv (27 B)`) are not failures.
 * - The useful line repeats the same 64-character oid three or four times
 *   (`error transferring "ffff…": [0] remote missing object ffff…`), which
 *   would blow the length cap before reaching the part that means something.
 *   Long hex runs are collapsed rather than dropped, so the sentence still
 *   reads as a sentence.
 * - Anything holding a path separator or a URL scheme is skipped entirely.
 *   That is the one hard guarantee: this text renders in a webview, and a
 *   remote URL or an absolute path is where a token or a private directory
 *   name would show up. A bare filename is not redacted — the user opened it.
 *
 * Exported for direct testing against captured git-lfs output: the fixtures in
 * `git-lfs-detail.test.ts` are real stderr, and they are the only way to keep
 * this honest without a live LFS remote in CI.
 */
export function sanitized_detail(stderr: string): string | undefined {
    const line = stderr
        .split('\n')
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate.length > 0
            && !candidate.startsWith('Downloading')
            && !/^(?:version|oid|size) /u.test(candidate)
            && !/[/\\]/u.test(candidate)
            && !candidate.includes('://'));
    if (!line) return undefined;
    const collapsed = line
        .replace(/\b[0-9a-f]{7,}\b/giu, '…')
        .replace(/\s+/gu, ' ')
        .trim();
    return collapsed.length > MAX_DETAIL_LENGTH
        ? `${collapsed.slice(0, MAX_DETAIL_LENGTH - 1)}…`
        : collapsed;
}

/**
 * A repository-relative path spelled so `git lfs pull --include=` matches that
 * one file and nothing else.
 *
 * `--include` takes `.gitignore`-style glob patterns, not literal paths, so a
 * filename containing a metacharacter is silently a *pattern*. Verified against
 * git-lfs 3.7.1: `--include=data[1].csv` reads `[1]` as a character class,
 * matches nothing, and `pull` still exits 0 — the file is left a pointer while
 * the command reports success. Escaping is exact rather than broad: pulling
 * `data\[1\].csv` fetches that file and leaves its neighbours untouched.
 *
 * `\` goes first so the backslashes this adds are not themselves re-escaped.
 */
export function escaped_include_pattern(relative: string): string {
    return relative.replace(/[\\[\]*?]/gu, (character) => `\\${character}`);
}

/**
 * A comma cannot be expressed at all: git-lfs splits the `--include` value on
 * commas before pattern matching, and a backslash does not escape the
 * separator (confirmed against 3.7.1 — `with\,comma.csv` matches nothing and
 * exits 0). Such a file is refused up front rather than pulled with a pattern
 * that cannot mean what it says.
 */
function include_pattern_can_express(relative: string): boolean {
    return !relative.includes(',');
}

/**
 * Which failure this was. A `git` that ran but does not know the `lfs`
 * subcommand reports it on stderr rather than with a distinct exit status, so
 * that text is the only signal available — and getting it right matters,
 * because "install git-lfs" and "try again" are the two different things the
 * banner can tell the user.
 */
function failure_reason(result: CommandResult): GitLfsFailureReason {
    if (result.spawnFailed) return 'lfsNotInstalled';
    const stderr = result.stderr.toLowerCase();
    if (
        stderr.includes("'lfs' is not a git command")
        || stderr.includes('lfs is not a git command')
        || stderr.includes('git: \'lfs\' is not')
    ) return 'lfsNotInstalled';
    if (stderr.includes('not a git repository')) return 'notARepository';
    // Observed against git-lfs 3.7.1, which exits 2 with this wording for both
    // `pull` and `smudge`. Distinguished from a transient transfer failure
    // because no retry can conjure bytes the remote does not have.
    if (
        stderr.includes('remote missing object')
        || stderr.includes('object does not exist')
        || stderr.includes('missing object')
    ) return 'objectMissing';
    return 'failed';
}

/**
 * The absolute working-tree path this resource names, or undefined when it does
 * not name one usable as a `cwd`.
 */
function file_path_of(resource: ResourceUriLike): string | undefined {
    // A `git:`-scheme resource still carries the working-tree path in
    // `fsPath`, which is exactly what locates the repository — but only a real
    // absolute path can be a `cwd`, so anything else refuses here rather than
    // spawning against an unknown directory.
    const candidate = resource.fsPath;
    return typeof candidate === 'string' && path.isAbsolute(candidate)
        ? candidate
        : undefined;
}

/**
 * `file_path` as git-lfs's `--include` wants it: relative to the repository
 * root, POSIX-separated.
 *
 * Asking git for the root rather than deriving it is the point. `--include`
 * patterns are resolved from the repository root no matter which directory
 * git-lfs is invoked from, so a bare basename silently matches same-named
 * files in *every* directory, and a `./`-prefixed basename matches nothing at
 * all — both verified against git-lfs 3.7. Neither failure reports itself:
 * `git lfs pull` exits 0 having fetched the wrong set, or nothing.
 */
/** `candidate` with symlinks resolved, or unchanged when it cannot be. */
function real_path(candidate: string): string {
    try {
        return fs.realpathSync.native(candidate);
    } catch {
        return candidate;
    }
}

type LocatedPath =
    | { readonly type: 'located'; readonly relative: string }
    /** `git` could not be executed at all. */
    | { readonly type: 'gitMissing' }
    /** git ran; the file is not in a repository this process can read. */
    | { readonly type: 'outsideRepository' };

async function repository_relative_path(file_path: string): Promise<LocatedPath> {
    const result = await run_git({
        cwd: path.dirname(file_path),
        args: ['rev-parse', '--show-toplevel'],
        maxStdout: 64 * 1024,
    });
    if (result.spawnFailed) return { type: 'gitMissing' };
    if (result.code !== 0) return { type: 'outsideRepository' };
    const root = Buffer.from(result.stdout).toString('utf8').trim();
    if (!root) return { type: 'outsideRepository' };
    // Both sides are resolved through realpath before being compared, because
    // git reports the *real* root and the URI holds whatever path the user
    // opened. On macOS that alone breaks it: `/var` is a symlink to
    // `/private/var`, so a repository under a temp directory yields a root of
    // `/private/var/…` against a file path of `/var/…`, and the relative path
    // between them escapes with `..`. Any symlinked checkout has the same
    // shape. Verified against a real repository — without this every pull
    // refused as `notARepository`.
    const relative = path.relative(real_path(root), real_path(file_path));
    // A path outside the root, or one that escapes it, is not this
    // repository's to fetch.
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return { type: 'outsideRepository' };
    }
    return { type: 'located', relative: relative.split(path.sep).join('/') };
}

/**
 * Whether the working-tree file now holds real content rather than a pointer.
 *
 * The pointer parser is reused deliberately: "did the pull work?" and "is this
 * a pointer?" are the same question, and answering it twice two ways is how the
 * two answers drift apart.
 */
async function working_tree_is_smudged(file_path: string): Promise<boolean> {
    try {
        const handle = await fs.promises.open(file_path, 'r');
        try {
            // Only the pointer-sized prefix is needed, and a real table can be
            // gigabytes — reading the whole file to classify it would undo the
            // streaming the rest of the viewer is careful about.
            const buffer = Buffer.alloc(1024);
            const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
            return parse_git_lfs_pointer(buffer.subarray(0, bytesRead)) === undefined;
        } finally {
            await handle.close();
        }
    } catch {
        // Unreadable is not smudged. The caller reports a failure and the
        // banner stays, which is the honest outcome.
        return false;
    }
}

export const node_git_lfs_port: GitLfsPort = {
    async pull(resource): Promise<GitLfsResolveOutcome> {
        const file_path = file_path_of(resource);
        if (!file_path) return { type: 'failed', reason: 'notARepository' };
        const located = await repository_relative_path(file_path);
        // `rev-parse` runs first, so it is also the first thing to fail when
        // `git` is not on PATH at all — and reporting that as "not a
        // repository" would send the user looking for the wrong problem.
        // Observed against a stripped PATH, where every pull refused with the
        // wrong reason.
        if (located.type !== 'located') {
            return {
                type: 'failed',
                reason: located.type === 'gitMissing' ? 'lfsNotInstalled' : 'notARepository',
            };
        }
        const relative = located.relative;
        // Better an honest refusal than a pull that exits 0 having matched
        // nothing, which the smudge check below would then report as
        // `filtersNotConfigured` — sending the user to run `git lfs install`
        // for a problem that has nothing to do with their filters.
        if (!include_pattern_can_express(relative)) {
            return {
                type: 'failed',
                reason: 'failed',
                detail: 'Git LFS cannot fetch a single file whose name contains a comma.',
            };
        }
        const result = await run_git({
            cwd: path.dirname(file_path),
            args: ['lfs', 'pull', `--include=${escaped_include_pattern(relative)}`],
            // `git lfs pull` writes progress, not content.
            maxStdout: 64 * 1024,
        });
        if (result.code !== 0) {
            const reason = failure_reason(result);
            const detail = sanitized_detail(result.stderr);
            return detail === undefined
                ? { type: 'failed', reason }
                : { type: 'failed', reason, detail };
        }
        // Exit 0 is not evidence the file was fetched, and this is not a
        // theoretical gap: in a repository where `git lfs install` was never
        // run, `git lfs pull` prints "Skipping object checkout" and exits 0
        // with the pointer untouched. Reporting that as resolved would clear
        // the banner off an unchanged grid and give the user nothing to press.
        // So the working tree is re-read and the answer is whatever it says.
        return await working_tree_is_smudged(file_path)
            ? { type: 'resolved' }
            : {
                type: 'failed',
                reason: 'filtersNotConfigured',
                ...(sanitized_detail(result.stderr) === undefined
                    ? {}
                    : { detail: sanitized_detail(result.stderr)! }),
            };
    },

    async smudge(resource, pointer: GitLfsPointer): Promise<GitLfsSmudgeOutcome> {
        const file_path = file_path_of(resource);
        if (!file_path) return { type: 'failed', reason: 'notARepository' };
        // Located for the same reason `pull` does it: to tell a missing `git`
        // apart from a file outside a repository. The relative path is not
        // needed here — `smudge` takes a plain filename for filter lookup —
        // but the diagnosis is.
        const located = await repository_relative_path(file_path);
        if (located.type === 'gitMissing') {
            return { type: 'failed', reason: 'lfsNotInstalled' };
        }
        if (located.type === 'outsideRepository') {
            return { type: 'failed', reason: 'notARepository' };
        }
        if (pointer.size > MAX_SMUDGE_BYTES) {
            return {
                type: 'failed',
                reason: 'failed',
                detail: 'The stored object is too large to load for comparison.',
            };
        }
        const encoder = new TextEncoder();
        const result = await run_git({
            cwd: path.dirname(file_path),
            // The pointer goes in on stdin and the object comes out on stdout;
            // nothing in the working tree is written. The path argument is how
            // git-lfs picks up this file's filter configuration.
            args: ['lfs', 'smudge', path.basename(file_path)],
            stdin: encoder.encode(
                'version https://git-lfs.github.com/spec/v1\n'
                + `oid sha256:${pointer.oid}\n`
                + `size ${pointer.size}\n`,
            ),
            maxStdout: pointer.size + SMUDGE_SIZE_SLACK,
        });
        if (result.overflowed) {
            return {
                type: 'failed',
                reason: 'failed',
                detail: 'The stored object did not match the size recorded for it.',
            };
        }
        if (result.code === 0) {
            // git-lfs echoes the pointer back when it cannot fetch the object,
            // and exits 0 doing it. Treating that as content is how a
            // "resolved" comparison would end up diffing pointer text again,
            // so the length is checked against what the pointer promised.
            if (result.stdout.byteLength !== pointer.size) {
                return {
                    type: 'failed',
                    reason: 'failed',
                    detail: sanitized_detail(result.stderr)
                        ?? 'The object could not be downloaded.',
                };
            }
            return { type: 'resolved', content: result.stdout };
        }
        const reason = failure_reason(result);
        const detail = sanitized_detail(result.stderr);
        return detail === undefined
            ? { type: 'failed', reason }
            : { type: 'failed', reason, detail };
    },
};
