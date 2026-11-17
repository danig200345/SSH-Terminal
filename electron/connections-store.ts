type StoredConnection = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authenticationType: 'password' | 'privateKey';
};

type StoreApi = {
  get(key: 'connections'): StoredConnection[];
  set(key: 'connections', value: StoredConnection[]): void;
};

export class ConnectionsStore {
  private store: StoreApi | null = null;

  async list(): Promise<StoredConnection[]> {
    return (await this.getStore()).get('connections');
  }

  async save(connection: StoredConnection): Promise<void> {
    const connections = await this.list();
    const index = connections.findIndex((item) => item.id === connection.id);
    const next = [...connections];

    if (index === -1) next.push(connection);
    else next[index] = connection;

    (await this.getStore()).set('connections', next);
  }

  async remove(id: string): Promise<void> {
    const connections = await this.list();
    (await this.getStore()).set('connections', connections.filter((item) => item.id !== id));
  }

  private async getStore(): Promise<StoreApi> {
    if (this.store) return this.store;

    const { default: ElectronStore } = await import('electron-store');
    this.store = new ElectronStore<{ connections: StoredConnection[] }>({
      defaults: { connections: [] },
    });
    return this.store;
  }
}
