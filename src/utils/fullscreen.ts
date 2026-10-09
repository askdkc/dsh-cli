import { isEnvTruthy } from './envUtils.js'

/**
 * Whether mouse click handling is disabled. dsh-cli reads its own environment
 * flag (`DSH_CLI_DISABLE_MOUSE`) for this decision.
 * @returns True when DSH_CLI_DISABLE_MOUSE is set to a truthy value.
 */
export function isMouseClicksDisabled(): boolean {
  return isEnvTruthy(process.env.DSH_CLI_DISABLE_MOUSE)
}
