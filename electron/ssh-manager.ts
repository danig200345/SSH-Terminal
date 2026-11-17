import { Client } from 'ssh2';
import type { ClientChannel, SFTPWrapper } from 'ssh2';
import { KnownHostsStore } from './known-hosts-store';

type ConnectionRequest = { id: string; host: string; port: number; username: string; password?: string; privateKey?: string };
type TerminalSize = { columns: number; rows: number };
type ShellSetup = { phase: 'waiting-prompt' | 'running' | 'done'; heldOutput: string; idleTimer: NodeJS.Timeout | null; timeout: NodeJS.Timeout | null };
type SshSession = {
  client: Client;
  stream: ClientChannel;
  listeners: Map<number, (data: string) => void>;
  // Salida reciente para restaurar la pestaña; se guarda en trozos para no copiar 200 KB en cada dato.
  history: string[];
  historyLength: number;
  pendingOutput: string;
  flushTimer: NodeJS.Immediate | null;
  setup: ShellSetup;
};
type RemoteDirectory = { path: string; entries: { name: string; kind: 'directory' | 'file' | 'link' | 'other' }[] };
type RemoteTextFile = { path: string; content: string };
const MAX_TEXT_FILE_BYTES = 1_000_000;
const MAX_HISTORY_CHARS = 200_000;
// La salida que llega en el mismo ciclo se envía junta con setImmediate (sin esperar).
// Secuencia que `clear` envía con TERM=xterm-256color para borrar también el historial.
const CLEAR_SCROLLBACK = '\x1b[3J';
// Espera a que el servidor deje de enviar el banner y el prompt antes de preparar la shell.
const PROMPT_IDLE_MS = 300;
const SETUP_TIMEOUT_MS = 5000;
const SETUP_DONE_MARKER = '\x1b]6973;listo\x07';
// Activa OSC 7 en Bash para que el árbol lateral siga los `cd`. El espacio inicial evita
// guardarlo en el historial (HISTCONTROL=ignorespace). Su eco se oculta en hideSetupCommand.
const SHELL_SETUP_COMMAND = ' if [ -n "$BASH_VERSION" ]; then __ssh_client_cwd() { printf "\\033]7;file://%s%s\\007" "$HOSTNAME" "$PWD"; }; case ";$PROMPT_COMMAND;" in *";__ssh_client_cwd;"*) ;; *) PROMPT_COMMAND="__ssh_client_cwd;$PROMPT_COMMAND";; esac; fi; printf "\\033]6973;listo\\007"\n';
const SETUP_ECHO_TEXT = 'BASH_VERSION';

export class SshManager {
  private readonly sessions = new Map<string, SshSession>();
  private readonly knownHosts = new KnownHostsStore();
  private readonly pendingHosts = new Map<string, string>();

  async connect(request: ConnectionRequest, size: TerminalSize, listenerKey: number, onData: (data: string) => void, onUnknownHost: (fingerprint: string) => void): Promise<void> {
    const existing = this.sessions.get(request.id);
    if (existing) {
      existing.listeners.set(listenerKey, onData);
      const history = existing.history.join('');
      if (history) onData(history);
      return;
    }
    const expected = await this.knownHosts.get(request.host, request.port);
    return new Promise((resolve, reject) => {
      const client = new Client(); let received: string | null = null;
      const pty = { term: 'xterm-256color', cols: size.columns, rows: size.rows };
      client.on('ready', () => {
        // Sin Nagle cada tecla sale al instante; con Nagle TCP la retiene hasta recibir confirmación.
        client.setNoDelay(true);
        client.shell(pty, (error, stream) => {
          if (error) { client.end(); reject(error); return; }
          const session: SshSession = {
            client, stream, listeners: new Map([[listenerKey, onData]]),
            history: [], historyLength: 0, pendingOutput: '', flushTimer: null,
            setup: { phase: 'waiting-prompt', heldOutput: '', idleTimer: null, timeout: null },
          };
          this.sessions.set(request.id, session);
          // Decodifica UTF-8 respetando caracteres partidos entre dos paquetes (acentos, emojis).
          stream.setEncoding('utf8');
          stream.on('data', (output: string) => this.onShellOutput(session, output));
          stream.on('close', () => { this.stopTimers(session); this.sessions.delete(request.id); });
          session.setup.timeout = setTimeout(() => this.finishSetup(session), SETUP_TIMEOUT_MS);
          this.waitForPrompt(session);
          resolve();
        });
      }).on('error', (error) => {
        if (received && !expected) { this.pendingHosts.set(this.key(request.host, request.port), received); onUnknownHost(received); reject(new Error('La identidad del servidor debe confirmarse antes de conectar.')); return; }
        if (received && expected) { reject(new Error('La identidad del servidor cambió. No se conectó por seguridad.')); return; }
        reject(error);
      }).connect({ host: request.host, port: request.port, username: request.username, password: request.password, privateKey: request.privateKey, hostHash: 'sha256', hostVerifier: (fingerprint: string) => { received = fingerprint; return expected === fingerprint; } });
    });
  }

  async listDirectory(id: string, path: string, listenerKey: number): Promise<RemoteDirectory> {
    const session = this.getSession(id);
    if (!session.listeners.has(listenerKey)) throw new Error('La sesión no pertenece a esta ventana.');

    return new Promise((resolve, reject) => {
      let channel: SFTPWrapper | undefined;
      let settled = false;
      const finish = (error?: Error, result?: RemoteDirectory) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        session.client.off('close', onClose);
        channel?.end();
        if (error) reject(error);
        else resolve(result!);
      };
      const onClose = () => finish(new Error('La conexión SSH se cerró. Vuelve a conectar para explorar archivos.'));
      const timeout = setTimeout(() => finish(new Error('El servidor tardó demasiado en responder por SFTP.')), 15_000);
      session.client.once('close', onClose);

      const onReadError = (error: Error & { code?: number }) => {
        const message = error.code === 2 ? 'La ruta no existe.'
          : error.code === 3 ? 'No tienes permiso para acceder a esta carpeta.'
          : 'No se pudo listar la carpeta. Comprueba la ruta y que sea un directorio.';
        finish(new Error(message));
      };

      session.client.sftp((error, sftp) => {
        if (settled) { sftp?.end(); return; }
        if (error) { finish(new Error('No se pudo abrir SFTP. Es posible que el servidor no lo permita.')); return; }
        channel = sftp;
        sftp.once('error', () => finish(new Error('Se interrumpió el canal SFTP. Intenta actualizar.')));
        sftp.once('close', () => finish(new Error('Se cerró el canal SFTP. Intenta actualizar.')));
        sftp.realpath(path, (error, absolutePath) => {
          if (settled) return;
          if (error) { onReadError(error); return; }
          // shortcut: readdir carga una carpeta completa; usar lectura por lotes si se necesitan directorios masivos.
          sftp.readdir(absolutePath, (error, files) => {
            if (settled) return;
            if (error) { onReadError(error); return; }
            if (files.length > 5000) {
              finish(new Error('La carpeta supera el límite de 5000 elementos. Introduce la ruta de una subcarpeta.'));
              return;
            }
            const entries = files.filter((file) => file.filename !== '.' && file.filename !== '..').map((file) => ({
              name: file.filename,
              kind: file.attrs.isDirectory() ? 'directory' as const : file.attrs.isFile() ? 'file' as const
                : file.attrs.isSymbolicLink() ? 'link' as const : 'other' as const,
            }));
            entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
            finish(undefined, { path: absolutePath, entries });
          });
        });
      });
    });
  }

  async createDirectory(id: string, parentPath: string, name: string, listenerKey: number): Promise<void> {
    const path = this.childPath(parentPath, name);
    await this.withSftp(id, listenerKey, (sftp) => new Promise<void>((resolve, reject) =>
      sftp.mkdir(path, { mode: 0o755 }, (error) => error ? reject(this.fileError(error, 'crear la carpeta')) : resolve())));
  }

  async createTextFile(id: string, parentPath: string, name: string, listenerKey: number): Promise<void> {
    const path = this.childPath(parentPath, name);
    await this.withSftp(id, listenerKey, (sftp) => new Promise<void>((resolve, reject) =>
      sftp.writeFile(path, '', { encoding: 'utf8', flag: 'wx', mode: 0o644 }, (error) => error ? reject(this.fileError(error, 'crear el archivo')) : resolve())));
  }

  async readTextFile(id: string, path: string, listenerKey: number): Promise<RemoteTextFile> {
    return this.withSftp(id, listenerKey, async (sftp) => {
      const stats = await new Promise<import('ssh2').Stats>((resolve, reject) => sftp.stat(path, (error, value) => error ? reject(error) : resolve(value)));
      if (!stats.isFile()) throw new Error('Solo se pueden abrir archivos de texto.');
      if (stats.size > MAX_TEXT_FILE_BYTES) throw new Error('El archivo supera el límite editable de 1 MB.');
      const data = await new Promise<Buffer>((resolve, reject) => sftp.readFile(path, (error, value) => error ? reject(error) : resolve(value)));
      if (data.includes(0)) throw new Error('El archivo parece binario y no se puede editar como texto.');
      try { return { path, content: new TextDecoder('utf-8', { fatal: true }).decode(data) }; }
      catch { throw new Error('El archivo no está codificado en UTF-8 y no se puede editar todavía.'); }
    });
  }

  async writeTextFile(id: string, path: string, content: string, listenerKey: number): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) throw new Error('El contenido supera el límite editable de 1 MB.');
    await this.withSftp(id, listenerKey, (sftp) => new Promise<void>((resolve, reject) =>
      sftp.writeFile(path, content, { encoding: 'utf8', flag: 'w' }, (error) => error ? reject(this.fileError(error, 'guardar el archivo')) : resolve())));
  }

  private async withSftp<T>(id: string, listenerKey: number, operation: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const session = this.getSession(id);
    if (!session.listeners.has(listenerKey)) throw new Error('La sesión no pertenece a esta ventana.');
    return new Promise<T>((resolve, reject) => {
      let channel: SFTPWrapper | undefined; let settled = false;
      const finish = (error?: Error, result?: T) => {
        if (settled) return; settled = true; clearTimeout(timeout); session.client.off('close', onClose); channel?.end();
        if (error) reject(error); else resolve(result!);
      };
      const onClose = () => finish(new Error('La conexión SSH se cerró. Vuelve a conectar para continuar.'));
      const timeout = setTimeout(() => finish(new Error('El servidor tardó demasiado en responder por SFTP.')), 15_000);
      session.client.once('close', onClose);
      session.client.sftp((error, sftp) => {
        if (settled) { sftp?.end(); return; }
        if (error || !sftp) { finish(new Error('No se pudo abrir SFTP. Es posible que el servidor no lo permita.')); return; }
        channel = sftp;
        sftp.once('error', () => finish(new Error('Se interrumpió el canal SFTP. Intenta de nuevo.')));
        sftp.once('close', () => finish(new Error('Se cerró el canal SFTP. Intenta de nuevo.')));
        void operation(sftp).then((result) => finish(undefined, result), (reason: unknown) => finish(reason instanceof Error ? reason : new Error('No se pudo completar la operación SFTP.')));
      });
    });
  }

  private childPath(parentPath: string, name: string): string { return `${parentPath.replace(/\/$/, '')}/${name}`; }
  private fileError(error: Error & { code?: number }, action: string): Error {
    return new Error(error.code === 3 ? `No tienes permiso para ${action}.` : error.code === 4 ? `El destino ya existe o el servidor rechazó ${action}.` : `No se pudo ${action}.`);
  }

  async trustHost(host: string, port: number, fingerprint: string): Promise<void> {
    const key = this.key(host, port);
    if (this.pendingHosts.get(key) !== fingerprint) throw new Error('No existe una confirmación pendiente para este servidor.');
    await this.knownHosts.save(host, port, fingerprint); this.pendingHosts.delete(key);
  }
  write(id: string, data: string): void { this.getSession(id).stream.write(data); }
  resize(id: string, columns: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.stream.setWindow(rows, columns, 0, 0);
  }
  disconnect(id: string): void { const session = this.sessions.get(id); if (!session) return; this.stopTimers(session); session.stream.close(); session.client.end(); this.sessions.delete(id); }
  disconnectAll(): void { [...this.sessions.keys()].forEach((id) => this.disconnect(id)); }
  // --- Salida de la shell ---
  private onShellOutput(session: SshSession, output: string): void {
    const setup = session.setup;
    if (setup.phase === 'done') { this.queueOutput(session, output); return; }
    // Mientras se prepara la shell, la salida se retiene para poder ocultar el comando.
    setup.heldOutput += output;
    if (setup.phase === 'waiting-prompt') this.waitForPrompt(session);
    else if (setup.heldOutput.includes(SETUP_DONE_MARKER)) this.finishSetup(session);
  }

  private waitForPrompt(session: SshSession): void {
    const setup = session.setup;
    if (setup.idleTimer) clearTimeout(setup.idleTimer);
    setup.idleTimer = setTimeout(() => {
      setup.idleTimer = null;
      if (setup.phase !== 'waiting-prompt') return;
      setup.phase = 'running';
      session.stream.write(SHELL_SETUP_COMMAND);
    }, PROMPT_IDLE_MS);
  }

  private finishSetup(session: SshSession): void {
    const setup = session.setup;
    if (setup.phase === 'done') return;
    setup.phase = 'done';
    this.stopSetupTimers(setup);
    const output = this.hideSetupCommand(setup.heldOutput);
    setup.heldOutput = '';
    if (output) this.queueOutput(session, output);
  }

  // Quita la línea del prompt donde se escribió el comando, su eco y el marcador final.
  // Si el marcador no llegó (por ejemplo, otra shell), se muestra la salida tal cual.
  private hideSetupCommand(output: string): string {
    const markerIndex = output.indexOf(SETUP_DONE_MARKER);
    if (markerIndex < 0) return output;
    const echoIndex = output.indexOf(SETUP_ECHO_TEXT);
    const cutStart = echoIndex < 0 || echoIndex > markerIndex ? markerIndex : output.lastIndexOf('\n', echoIndex) + 1;
    return output.slice(0, cutStart) + output.slice(markerIndex + SETUP_DONE_MARKER.length);
  }

  private queueOutput(session: SshSession, output: string): void {
    session.pendingOutput += output;
    if (!session.flushTimer) session.flushTimer = setImmediate(() => this.flushOutput(session));
  }

  private flushOutput(session: SshSession): void {
    session.flushTimer = null;
    const output = session.pendingOutput;
    session.pendingOutput = '';
    if (!output) return;
    this.rememberOutput(session, output);
    session.listeners.forEach((listener) => listener(output));
  }

  private rememberOutput(session: SshSession, output: string): void {
    // Tras un `clear`, lo anterior ya no debe volver a aparecer al restaurar la pestaña.
    const clearIndex = output.lastIndexOf(CLEAR_SCROLLBACK);
    if (clearIndex >= 0) {
      session.history = [];
      session.historyLength = 0;
      output = output.slice(clearIndex);
    }
    session.history.push(output);
    session.historyLength += output.length;
    while (session.historyLength > MAX_HISTORY_CHARS && session.history.length > 1) {
      session.historyLength -= session.history.shift()!.length;
    }
  }

  private stopTimers(session: SshSession): void {
    if (session.flushTimer) clearImmediate(session.flushTimer);
    session.flushTimer = null;
    this.stopSetupTimers(session.setup);
  }

  private stopSetupTimers(setup: ShellSetup): void {
    if (setup.idleTimer) clearTimeout(setup.idleTimer);
    if (setup.timeout) clearTimeout(setup.timeout);
    setup.idleTimer = null;
    setup.timeout = null;
  }

  private getSession(id: string): SshSession { const session = this.sessions.get(id); if (!session) throw new Error('La sesión SSH no existe.'); return session; }
  private key(host: string, port: number): string { return `${host}:${port}`; }
}
