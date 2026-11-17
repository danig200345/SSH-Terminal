type StoreApi = {
  get(key: 'hosts'): Record<string, string>;
  set(key: 'hosts', value: Record<string, string>): void;
};

/** Guarda únicamente fingerprints confirmados por el usuario. */
export class KnownHostsStore {
  private store: StoreApi | null = null;

  async get(host: string, port: number): Promise<string | null> {
    return (await this.getStore()).get('hosts')[this.key(host, port)] ?? null;
  }

  async save(host: string, port: number, fingerprint: string): Promise<void> {
    const store = await this.getStore();
    const hosts = store.get('hosts');
    hosts[this.key(host, port)] = fingerprint;
    store.set('hosts', hosts);
  }

  private key(host: string, port: number): string {
    return `${host}:${port}`;
  }

  private async getStore(): Promise<StoreApi> {
    if (this.store) return this.store;
    const { default: ElectronStore } = await import('electron-store');
    this.store = new ElectronStore<Record<'hosts', Record<string, string>>>({
      name: 'known-hosts',
      defaults: { hosts: {} },
    });
    return this.store;
  }
}
