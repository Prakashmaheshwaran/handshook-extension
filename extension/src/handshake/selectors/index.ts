/**
 * Selector strategy groups, re-exported for adapter consumers.
 *
 * Other feature groups (documents, apply, questions, verification) are owned
 * by their feature tasks and will be added here when those files land.
 */

export { discoverySelectors } from './discovery';
export type { DiscoverySelectorGroup } from './discovery';
export { jobSelectors } from './job';
export type { JobSelectorGroup } from './job';
