import { safeStorage } from 'electron';

type StoreApi = {
  get(key: 'secrets'): Record<string, string>;
  set(key: 'secrets', value: Record<string, string>): void;
  delete(key: 'secrets'): void;
};

export class SecretsStore {
  private store: StoreApi | null = null;

  async savePassword(connectionId: string, password: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('El almacenamiento seguro del sistema no está disponible.');
    }

    const secrets = (await this.getStore()).get('secrets');
    secrets[connectionId] = safeStorage.encryptString(password).toString('base64');
    (await this.getStore()).set('secrets', secrets);
  }

  async getPassword(connectionId: string): Promise<string | null> {
    const encrypted = (await this.getStore()).get('secrets')[connectionId];
    if (!encrypted) return null;
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }

  async remove(connectionId: string): Promise<void> {
    const store = await this.getStore();
    const secrets = store.get('secrets');
    delete secrets[connectionId];
    store.set('secrets', secrets);
  }

  private async getStore(): Promise<StoreApi> {
    if (this.store) return this.store;
    const { default: ElectronStore } = await import('electron-store');
    this.store = new ElectronStore<Record<'secrets', Record<string, string>>>({
      name: 'secrets',
      defaults: { secrets: {} },
    });
    return this.store;
  }
}
