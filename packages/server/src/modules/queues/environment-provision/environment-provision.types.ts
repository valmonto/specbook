export interface EnvironmentProvisionJobPayload {
  /** Set for PROVISION jobs — the worker loads everything else itself. */
  environmentId?: string;
  /**
   * Set for DEPROVISION jobs — a snapshot taken BEFORE the environment row
   * was deleted, since nothing remains to load afterwards. `serverId` is the
   * app server (where the compose stack and, for a NULL placement, the whole
   * data plane lives); the optional ids name servers a role was MOVED to.
   */
  deprovision?: {
    serverId: string;
    unit: string;
    databaseServerId?: string | null;
    cacheServerId?: string | null;
  };
}
