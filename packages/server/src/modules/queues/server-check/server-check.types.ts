export interface ServerCheckJobPayload {
  /** Check one server… */
  serverId?: string;
  /** …or sweep every server (scheduled). */
  sweep?: boolean;
}
