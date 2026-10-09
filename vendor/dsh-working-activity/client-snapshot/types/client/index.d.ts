/**
 * Working-activity surface plugin, browser half: the working-line entry in
 * the conversation.input.dock strip.
 *
 * The node half folds every committed session event into the `workingActivity`
 * session projection and the host ships that value to clients; this dock entry
 * reads it through the session standard kit's `useProjection` and owns no
 * store, no refresh chain, and no event listener. Nothing is appended to the
 * session log — the reason dsh-cli mounts this plugin with `publish: false`.
 *
 * Mount contract (see the root README's "Web UI 集成" section): the web
 * client's client-modules host scans loader entries for `dsh.client`
 * declarations and serves this package's `./client` bundle at
 * /plugins/dsh-working-activity/client.js. The entry contributes into the
 * input dock — no official-source patch is involved.
 */
import type { Context } from '@deepseek-ai/cordis';
export { WorkingLine, type WorkingLineProps } from './WorkingLine.tsx';
export type { WorkingActivityView } from './activity.ts';
/** Required services for the dock registration. */
export declare const inject: string[];
/**
 * Client plugin body: the working-line dock entry.
 * @param ctx - client root context.
 */
export declare function apply(ctx: Context): void;
