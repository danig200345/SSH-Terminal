import { ipcMain } from 'electron';
import { ConnectionsStore } from './connections-store';
import { SecretsStore } from './secrets-store';
import { SshManager } from './ssh-manager';

type ConnectionInput = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authenticationType: 'password' | 'privateKey';
};

const store = new ConnectionsStore();
const secretsStore = new SecretsStore();
const sshManager = new SshManager();

function isSftpPath(id: unknown, path: unknown): id is string {
  return typeof id === 'string' && !!id && typeof path === 'string' && !!path && path.length <= 4096 && !path.includes('\0');
}

function isTerminalSize(columns: unknown, rows: unknown): boolean {
  const isValid = (value: unknown) => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 1000;
  return isValid(columns) && isValid(rows);
}

function isSftpName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && name.trim() === name && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}

function isConnectionInput(value: unknown): value is ConnectionInput {
  if (!value || typeof value !== 'object') return false;
  const connection = value as Record<string, unknown>;

  return (
    typeof connection['id'] === 'string' &&
    typeof connection['name'] === 'string' &&
    typeof connection['host'] === 'string' &&
    typeof connection['username'] === 'string' &&
    Number.isInteger(connection['port']) &&
    (connection['port'] as number) >= 1 &&
    (connection['port'] as number) <= 65535 &&
    (connection['authenticationType'] === 'password' || connection['authenticationType'] === 'privateKey')
  );
}

export function registerIpcHandlers(): void {
  ipcMain.handle('connections:list', () => store.list());

  ipcMain.handle('connections:save', async (_event, connection: unknown) => {
    if (!isConnectionInput(connection)) throw new Error('Los datos de conexión no son válidos.');
    await store.save(connection);
  });

  ipcMain.handle('connections:remove', async (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('El identificador no es válido.');
    await store.remove(id);
    await secretsStore.remove(id);
  });

  ipcMain.handle('credentials:savePassword', async (_event, id: unknown, password: unknown) => {
    if (typeof id !== 'string' || typeof password !== 'string' || password.length === 0) {
      throw new Error('La contraseña no es válida.');
    }
    await secretsStore.savePassword(id, password);
  });

  ipcMain.handle('ssh:connect', async (event, id: unknown, columns: unknown, rows: unknown) => {
    if (typeof id !== 'string') throw new Error('El identificador no es válido.');
    if (!isTerminalSize(columns, rows)) throw new Error('El tamaño de terminal no es válido.');
    const profile = (await store.list()).find((connection) => connection.id === id);
    if (!profile) throw new Error('La conexión no existe.');
    const storedPassword = profile.authenticationType === 'password' ? await secretsStore.getPassword(id) : null;
    if (profile.authenticationType === 'password' && !storedPassword) throw new Error('No hay una contraseña guardada para esta conexión.');
    const password = storedPassword ?? undefined;

    try {
      await sshManager.connect(
        { ...profile, password },
        { columns: columns as number, rows: rows as number },
        event.sender.id,
        // La ventana pudo cerrarse mientras llegaba salida del servidor.
        (data) => { if (!event.sender.isDestroyed()) event.sender.send('ssh:data', id, data); },
        (fingerprint) => event.sender.send('ssh:unknown-host', id, profile.host, profile.port, fingerprint),
      );
      return { status: 'connected' };
    } catch (error) {
      if (error instanceof Error && error.message === 'La identidad del servidor debe confirmarse antes de conectar.') {
        return { status: 'unknown-host' };
      }
      throw error;
    }
  });

  ipcMain.handle('ssh:trustHost', (_event, host: unknown, port: unknown, fingerprint: unknown) => {
    if (typeof host !== 'string' || !Number.isInteger(port) || typeof fingerprint !== 'string') throw new Error('La fingerprint no es válida.');
    return sshManager.trustHost(host, port as number, fingerprint);
  });

  ipcMain.handle('sftp:listDirectory', (event, id: unknown, path: unknown) => {
    if (typeof id !== 'string' || !id || typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) {
      throw new Error('La sesión o la ruta no son válidas.');
    }
    return sshManager.listDirectory(id, path, event.sender.id);
  });

  ipcMain.handle('sftp:createDirectory', (event, id: unknown, parentPath: unknown, name: unknown) => {
    if (!isSftpPath(id, parentPath) || !isSftpName(name)) throw new Error('La sesión, ruta o nombre no son válidos.');
    return sshManager.createDirectory(id, parentPath as string, name, event.sender.id);
  });

  ipcMain.handle('sftp:createTextFile', (event, id: unknown, parentPath: unknown, name: unknown) => {
    if (!isSftpPath(id, parentPath) || !isSftpName(name)) throw new Error('La sesión, ruta o nombre no son válidos.');
    return sshManager.createTextFile(id, parentPath as string, name, event.sender.id);
  });

  ipcMain.handle('sftp:readTextFile', (event, id: unknown, path: unknown) => {
    if (!isSftpPath(id, path)) throw new Error('La sesión o la ruta no son válidas.');
    return sshManager.readTextFile(id, path as string, event.sender.id);
  });

  ipcMain.handle('sftp:writeTextFile', (event, id: unknown, path: unknown, content: unknown) => {
    if (!isSftpPath(id, path) || typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 1_000_000) {
      throw new Error('La sesión, ruta o contenido no son válidos.');
    }
    return sshManager.writeTextFile(id, path as string, content, event.sender.id);
  });

  // Las teclas usan `send` (sin respuesta) para no esperar una ida y vuelta por cada pulsación.
  ipcMain.on('ssh:write', (_event, id: unknown, data: unknown) => {
    if (typeof id !== 'string' || typeof data !== 'string') return;
    try { sshManager.write(id, data); } catch { /* La sesión ya se cerró. */ }
  });

  ipcMain.handle('ssh:resize', (_event, id: unknown, columns: unknown, rows: unknown) => {
    if (!isTerminalSize(columns, rows) || typeof id !== 'string') throw new Error('El tamaño de terminal no es válido.');
    sshManager.resize(id, columns as number, rows as number);
  });

  ipcMain.handle('ssh:disconnect', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('El identificador no es válido.');
    sshManager.disconnect(id);
  });
}
