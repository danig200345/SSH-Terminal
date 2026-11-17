import { computed, Injectable, signal } from '@angular/core';
import type {
  ConnectionDraft,
  ConnectionProfile,
} from '../models/connection';

@Injectable({
  providedIn: 'root',
})
export class ConnectionService {
  private readonly connectionList = signal<readonly ConnectionProfile[]>([]);
  private readonly selectedId = signal<string | null>(null);

  constructor() {
    void this.loadConnections();
  }

  /** Lista de conexiones disponible mientras la aplicación está abierta. */
  readonly connections = this.connectionList.asReadonly();

  /** Identificador de la conexión elegida por el usuario. */
  readonly selectedConnectionId = this.selectedId.asReadonly();

  /** Conexión elegida, o null cuando todavía no hay una selección. */
  readonly selectedConnection = computed(() => {
    const selectedId = this.selectedId();

    return (
      this.connectionList().find((connection) => connection.id === selectedId) ??
      null
    );
  });

  async addConnection(draft: ConnectionDraft): Promise<ConnectionProfile> {
    const connection: ConnectionProfile = {
      id: crypto.randomUUID(),
      ...draft,
    };

    await window.electronAPI?.connections.save(connection);
    this.connectionList.update((connections) => [...connections, connection]);

    return connection;
  }

  async updateConnection(id: string, draft: ConnectionDraft): Promise<ConnectionProfile> {
    const connection: ConnectionProfile = { id, ...draft };
    await window.electronAPI?.connections.save(connection);
    this.connectionList.update((connections) =>
      connections.map((item) => (item.id === id ? connection : item)),
    );
    return connection;
  }

  selectConnection(id: string | null): void {
    const connectionExists = this.connectionList().some(
      (connection) => connection.id === id,
    );

    this.selectedId.set(connectionExists ? id : null);
  }

  async removeConnection(id: string): Promise<void> {
    await window.electronAPI?.connections.remove(id);
    this.connectionList.update((connections) =>
      connections.filter((connection) => connection.id !== id),
    );

    if (this.selectedId() === id) {
      this.selectedId.set(null);
    }
  }

  private async loadConnections(): Promise<void> {
    const connections = await window.electronAPI?.connections.list();
    if (connections) this.connectionList.set(connections);
  }
}
