import packageJson from '../../package.json';

/** The web application's version, read from its own manifest so the two cannot drift. */
export const APP_VERSION: string = packageJson.version;
