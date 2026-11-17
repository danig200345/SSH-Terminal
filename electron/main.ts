import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'node:path';
import { registerIpcHandlers } from './ipc';

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'SSH Client',
    backgroundColor: '#000000',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    show: false
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];

  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../ssh-client/browser/index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // En Windows, al volver con Alt+Tab el teclado no siempre regresa al contenido de la ventana.
  mainWindow.on('focus', () => mainWindow?.webContents.focus());
  mainWindow.on('closed', () => (mainWindow = null));
}

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
