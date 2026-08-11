/**
 * Research value sets and the status protocol — the single source, used by the
 * Zod schemas here, the varchar CHECK constraint in @pkg/database, and the
 * lifecycle guards in the API. Zod-free: ships in frontend bundles.
 *
 * A research document is produced through an async agent conversation and,
 * unlike a task, its evidence of "done" is the document itself, not a PR.
 *
 * The status protocol:
 * - researching:  an agent turn is in flight or awaited — the document is
 *                 being drafted/revised. The agent feed (list_research) pulls
 *                 from here.
 * - needs_review: a draft is ready for the human. The agent's reply sets the
 *                 new body, bumps the version, and moves here.
 * - accepted:     finalized — the human accepted the document. The natural
 *                 next step is cutting draft tickets from it.
 *
 * The reopen path accepted → needs_review is human-only, mirroring the task
 * reopen arc (done → changes_requested): a finalized document can be sent
 * back for another round, agents can never resurrect their own accepted work.
 */
export const RESEARCH_STATUSES = ['researching', 'needs_review', 'accepted'] as const;
