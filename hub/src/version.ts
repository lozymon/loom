import pkg from "../package.json" with { type: "json" };

/** The hub package version, fixed at build time when bundled. */
export const HUB_VERSION: string = pkg.version;
