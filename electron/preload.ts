import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktopApp: true,
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    save: (connection: unknown) => ipcRenderer.invoke('connections:save', connection),
    remove: (id: string) => ipcRenderer.invoke('connections:remove', id),
  },
  credentials: {
    savePassword: (id: string, password: string) =>
      ipcRenderer.invoke('credentials:savePassword', id, password),
  },
  sftp: {
    listDirectory: (id: string, path: string) => ipcRenderer.invoke('sftp:listDirectory', id, path),
    createDirectory: (id: string, parentPath: string, name: string) => ipcRenderer.invoke('sftp:createDirectory', id, parentPath, name),
    createTextFile: (id: string, parentPath: string, name: string) => ipcRenderer.invoke('sftp:createTextFile', id, parentPath, name),
    readTextFile: (id: string, path: string) => ipcRenderer.invoke('sftp:readTextFile', id, path),
    writeTextFile: (id: string, path: string, content: string) => ipcRenderer.invoke('sftp:writeTextFile', id, path, content),
  },
  ssh: {
    connect: (id: string, columns: number, rows: number) => ipcRenderer.invoke('ssh:connect', id, columns, rows),
    write: (id: string, data: string) => ipcRenderer.send('ssh:write', id, data),
    resize: (id: string, columns: number, rows: number) => ipcRenderer.invoke('ssh:resize', id, columns, rows),
    disconnect: (id: string) => ipcRenderer.invoke('ssh:disconnect', id),
    trustHost: (host: string, port: number, fingerprint: string) => ipcRenderer.invoke('ssh:trustHost', host, port, fingerprint),
    // Devuelven una función para dejar de escuchar; la terminal la llama al destruirse.
    onData: (listener: (id: string, data: string) => void) => {
      const handler = (_event: IpcRendererEvent, id: string, data: string) => listener(id, data);
      ipcRenderer.on('ssh:data', handler);
      return () => { ipcRenderer.removeListener('ssh:data', handler); };
    },
    onUnknownHost: (listener: (id: string, host: string, port: number, fingerprint: string) => void) => {
      const handler = (_event: IpcRendererEvent, id: string, host: string, port: number, fingerprint: string) => listener(id, host, port, fingerprint);
      ipcRenderer.on('ssh:unknown-host', handler);
      return () => { ipcRenderer.removeListener('ssh:unknown-host', handler); };
    },
  },
});