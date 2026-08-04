export interface EnvironmentProvisionJobPayload {
  /** Set for PROVISION jobs — the worker loads everything else itself. */
  environmentId?: string;
  /**
   * Set for DEPROVISION jobs — a snapshot taken BEFORE the environment row
   * was deleted, since nothing remains to load afterwards.
   */
  deprovision?: {
    serverId: string;
    unit: string;
  };
}
