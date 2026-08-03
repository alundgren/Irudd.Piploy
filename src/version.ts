declare const __PIPLOY_VERSION__: string;

/**
 * The release tag (e.g. `v1.2.3`) when built at a tagged commit — matching
 * `tag_name` in the GitHub Releases API exactly, for self-update's
 * comparison — otherwise the package version plus the build's short git
 * commit hash, for local/dev builds.
 */
export const piployVersion = __PIPLOY_VERSION__;
