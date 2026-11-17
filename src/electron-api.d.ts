import type { ConnectionProfile } from './app/models/connection';

export type RemoteDirectory = {
  path: string;
  entries: { name: string; kind: 'directory' | 'file' | 'link' | 'other' }[];
};

export type RemoteTextFile = { path: string; content: string };

declare global {
  interface Window {
    electronAPI?: {
      readonly isDesktopApp: boolean;
      readonly connections: {
        list(): Promise<ConnectionProfile[]>;
        save(connection: ConnectionProfile): Promise<void>;
        remove(id: string): Promise<void>;
      };
      readonly credentials: {
        savePassword(id: string, password: string): Promise<void>;
      };
      readonly sftp: {
        listDirectory(id: string, path: string): Promise<RemoteDirectory>;
        createDirectory(id: string, parentPath: string, name: string): Promise<void>;
        createTextFile(id: string, parentPath: string, name: string): Promise<void>;
        readTextFile(id: string, path: string): Promise<RemoteTextFile>;
        writeTextFile(id: string, path: string, content: string): Promise<void>;
      };
      readonly ssh: {
        connect(id: string, columns: number, rows: number): Promise<{ status: 'connected' | 'unknown-host' }>;
        write(id: string, data: string): void;
        resize(id: string, columns: number, rows: number): Promise<void>;
        disconnect(id: string): Promise<void>;
        trustHost(host: string, port: number, fingerprint: string): Promise<void>;
        onData(listener: (id: string, data: string) => void): () => void;
        onUnknownHost(listener: (id: string, host: string, port: number, fingerprint: string) => void): () => void;
      };
    };
  }
}

export {};
