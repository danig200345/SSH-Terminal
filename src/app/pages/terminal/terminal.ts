import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, HostListener, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, ISearchOptions } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as XtermTerminal } from '@xterm/xterm';
import { SessionService } from '../../services/session';
import { ConnectionService } from '../../services/connection';
import type { RemoteDirectory } from '../../../electron-api';

type DirectoryState = { data?: RemoteDirectory; loading: boolean; error: string | null };
type ExplorerRow = {
  path: string; name: string; kind: RemoteDirectory['entries'][number]['kind'];
  parent: string | null; depth: number; expanded: boolean; state?: DirectoryState;
};
type ExplorerSnapshot = {
  directory: RemoteDirectory | null; states: Record<string, DirectoryState>; expanded: ReadonlySet<string>;
  selected: string | null; pathDraft: string; filter: string;
};

@Component({
  selector: 'app-terminal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './terminal.html',
  styleUrl: './terminal.css',
})
export class Terminal implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  readonly sessions = inject(SessionService);
  private readonly connections = inject(ConnectionService);
  private readonly router = inject(Router);
  readonly sessionId = this.route.snapshot.paramMap.get('id') ?? '';
  readonly container = viewChild.required<ElementRef<HTMLElement>>('terminalContainer');
  readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  readonly status = signal<'connecting' | 'connected' | 'error'>('connecting');
  readonly errorMessage = signal<string | null>(null);
  readonly unknownHost = signal<{ host: string; port: number; fingerprint: string } | null>(null);
  readonly serverLabel = computed(() => {
    const connection = this.connections.connections().find((item) => item.id === this.sessionId);
    return connection ? `${connection.name} · ${connection.username}@${connection.host}` : 'Sesión SSH';
  });
  readonly explorerOpen = signal(true);
  readonly activeView = signal<'terminal' | 'files'>('terminal');
  readonly directory = signal<RemoteDirectory | null>(null);
  readonly pathDraft = signal('.');
  readonly managerPathDraft = signal('.');
  readonly fileFilter = signal('');
  readonly directoryLoading = signal(false);
  readonly directoryError = signal<string | null>(null);
  readonly treeElement = viewChild<ElementRef<HTMLElement>>('fileTree');
  readonly directoryStates = signal<Record<string, DirectoryState>>({});
  readonly expandedPaths = signal<ReadonlySet<string>>(new Set());
  readonly selectedPath = signal<string | null>(null);
  readonly treeRefreshing = signal(false);
  readonly visibleTree = computed(() => {
    const root = this.directory();
    if (!root) return [];
    const states = this.directoryStates();
    const expanded = this.expandedPaths();
    const filter = this.fileFilter().toLocaleLowerCase();
    const visit = (path: string, name: string, kind: ExplorerRow['kind'], parent: string | null, depth: number): ExplorerRow[] => {
      const state = states[path];
      const children = (state?.data?.entries ?? []).flatMap((entry) =>
        visit(`${path.replace(/\/$/, '')}/${entry.name}`, entry.name, entry.kind, path, depth + 1));
      if (parent && filter && !name.toLocaleLowerCase().includes(filter) && !children.length) return [];
      const row: ExplorerRow = { path, name, kind, parent, depth, expanded: expanded.has(path), state };
      return [row, ...(row.expanded ? children : [])];
    };
    return visit(root.path, root.path.split('/').at(-1) || '/', 'directory', null, 0);
  });
  readonly focusedTreePath = computed(() => this.visibleTree().some((row) => row.path === this.selectedPath())
    ? this.selectedPath() : this.directory()?.path);
  readonly managerDirectory = signal<RemoteDirectory | null>(null);
  readonly createKind = signal<'folder' | 'file' | null>(null);
  readonly newItemName = signal('');
  readonly fileActionError = signal<string | null>(null);
  readonly fileActionLoading = signal(false);
  readonly editorTabs = signal<{ path: string; original: string; content: string }[]>([]);
  readonly activeEditorPath = signal<string | null>(null);
  readonly editor = computed(() => this.editorTabs().find((tab) => tab.path === this.activeEditorPath()) ?? null);
  readonly editorLoading = signal(false);
  readonly editorSaving = signal(false);
  readonly editorError = signal<string | null>(null);
  readonly editorDirty = computed(() => { const editor = this.editor(); return !!editor && editor.content !== editor.original; });
  readonly fileHistory = signal<string[]>([]);
  readonly fileHistoryIndex = signal(-1);
  readonly canGoBack = computed(() => this.fileHistoryIndex() > 0);
  readonly canGoForward = computed(() => this.fileHistoryIndex() >= 0 && this.fileHistoryIndex() < this.fileHistory().length - 1);
  readonly canGoUp = computed(() => !!this.managerDirectory()?.path && this.managerDirectory()?.path !== '/');
  private rootRequest = 0;
  private managerRequest = 0;
  private treeVersion = 0;
  private terminalExplorer: ExplorerSnapshot | null = null;
  private editorExplorer: ExplorerSnapshot | null = null;
  private directoryReportHandler: { dispose(): void } | null = null;
  private stopListeningData: (() => void) | null = null;
  private stopListeningUnknownHost: (() => void) | null = null;
  private fitScheduled = false;
  private destroyed = false;

  // Búsqueda en terminal
  readonly searchOpen = signal(false);
  readonly searchQuery = signal('');
  readonly searchCaseSensitive = signal(false);
  readonly searchWholeWord = signal(false);
  readonly searchRegex = signal(false);
  readonly searchResult = signal<{ index: number; count: number } | null>(null);
  readonly contextMenu = signal<{ x: number; y: number } | null>(null);

  private readonly terminal = new XtermTerminal({
    // El resaltado de SearchAddon utiliza registerDecoration, una API propuesta de xterm.
    allowProposedApi: true,
    cursorBlink: true,
    scrollback: 5000,
    fontFamily: 'SF Mono, Menlo, Monaco, Consolas, monospace',
    fontSize: 14,
    lineHeight: 1.35,
    theme: {
      background: '#050507', foreground: '#e6e8ec', cursor: '#0a84ff', cursorAccent: '#050507',
      selectionBackground: '#24466e', selectionInactiveBackground: '#1d2c3d',
      black: '#15161a', brightBlack: '#6e6e73',
      red: '#ff6b63', brightRed: '#ff8a84',
      green: '#30d158', brightGreen: '#5be07a',
      yellow: '#ffd60a', brightYellow: '#ffe066',
      blue: '#4a9eff', brightBlue: '#7ab8ff',
      magenta: '#bf8bff', brightMagenta: '#d6a8ff',
      cyan: '#64d2ff', brightCyan: '#8fe3ff',
      white: '#e6e8ec', brightWhite: '#ffffff'
    },
  });
  private readonly fitAddon = new FitAddon();
  private readonly searchAddon = new SearchAddon();
  private resizeObserver: ResizeObserver | null = null;

  async ngAfterViewInit(): Promise<void> {
    const label = this.connections.connections().find((connection) => connection.id === this.sessionId)?.name ?? 'Sesión SSH';
    this.sessions.open(this.sessionId, label);
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    const terminalElement = this.container().nativeElement;
    this.terminal.open(terminalElement);
    this.loadGpuRenderer();
    this.directoryReportHandler = this.terminal.parser.registerOscHandler(7, (data) => this.onTerminalDirectoryReport(data));
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(terminalElement);
    this.fitAddon.fit();
    this.terminal.focus();

    this.searchAddon.onDidChangeResults((event) => {
      this.searchResult.set({ index: event.resultIndex, count: event.resultCount });
    });
    this.terminal.onData((data) => void window.electronAPI?.ssh.write(this.sessionId, data));
    this.terminal.onResize(({ cols, rows }) => void window.electronAPI?.ssh.resize(this.sessionId, cols, rows));
    // Auto-copia una sola vez al soltar el ratón, no en cada cambio de la selección.
    terminalElement.addEventListener('mouseup', () => {
      const selection = this.terminal.getSelection();
      if (!this.searchOpen() && selection) void this.copySelection(selection);
    });
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (event.ctrlKey && event.shiftKey && (event.key === 'C' || event.key === 'c')) {
        event.preventDefault();
        const selection = this.terminal.getSelection();
        if (selection) void this.copySelection(selection);
        return false;
      }
      if (event.ctrlKey && event.shiftKey && (event.key === 'V' || event.key === 'v')) {
        // Devolver false detiene xterm, pero no el pegado nativo de Chromium.
        event.preventDefault();
        void this.pasteFromClipboard();
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        this.openSearch();
        return false;
      }
      return true;
    });

    this.stopListeningData = window.electronAPI?.ssh.onData((id, data) => { if (id === this.sessionId) this.terminal.write(data); }) ?? null;
    this.stopListeningUnknownHost = window.electronAPI?.ssh.onUnknownHost((id, host, port, fingerprint) => {
      if (id === this.sessionId) this.unknownHost.set({ host, port, fingerprint });
    }) ?? null;
    await this.connect();
  }

  // Al volver de otra app: repinta la terminal y le devuelve el teclado si nada más lo tenía.
  @HostListener('window:focus')
  onWindowFocus(): void {
    if (this.destroyed || this.activeView() !== 'terminal' || this.searchOpen()) return;
    this.terminal.refresh(0, this.terminal.rows - 1);
    const active = document.activeElement;
    if (!active || active === document.body || this.container().nativeElement.contains(active)) this.terminal.focus();
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    this.contextMenu.set(null);
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      this.openSearch();
    }
    if (event.key === 'Escape') {
      if (this.contextMenu()) this.contextMenu.set(null);
      if (this.searchOpen()) this.closeSearch();
    }
  }

  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    this.contextMenu.set({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  openConnections(): void {
    void this.router.navigateByUrl('/');
  }

  setView(view: 'terminal' | 'files'): void {
    const previous = this.activeView();
    if (previous !== view) {
      this.saveExplorer(previous);
      this.restoreExplorer(view);
      this.activeView.set(view);
    }
    if (view === 'files' && this.managerDirectory()?.path) {
      this.rememberFileDirectory(this.managerDirectory()!.path);
      this.managerPathDraft.set(this.managerDirectory()!.path);
    }
    if (view === 'terminal') {
      requestAnimationFrame(() => {
        this.fitAddon.fit();
        this.terminal.focus();
      });
    }
  }

  openTab(id: string): void {
    this.sessions.activate(id);
    void this.router.navigate(['/terminal', id]);
  }

  closeTab(id: string, event: MouseEvent): void {
    event.stopPropagation();
    void window.electronAPI?.ssh.disconnect(id);
    this.sessions.close(id);
    void this.router.navigateByUrl('/');
  }

  async trustHost(): Promise<void> {
    const host = this.unknownHost(); if (!host) return;
    await window.electronAPI?.ssh.trustHost(host.host, host.port, host.fingerprint);
    this.unknownHost.set(null); await this.connect();
  }

  async loadDirectory(path: string): Promise<void> {
    if (this.status() !== 'connected') return;
    const request = ++this.rootRequest;
    this.directoryLoading.set(true);
    this.directoryError.set(null);
    try {
      const api = window.electronAPI;
      if (!api) throw new Error('El explorador remoto solo está disponible en la aplicación de escritorio.');
      const base = this.directory()?.path;
      const requestedPath = base && !path.startsWith('/') ? `${base.replace(/\/$/, '')}/${path}` : path;
      const result = await api.sftp.listDirectory(this.sessionId, requestedPath);
      if (this.destroyed || request !== this.rootRequest) return;
      this.treeVersion++;
      this.directory.set(result);
      this.directoryStates.set({ [result.path]: { data: result, loading: false, error: null } });
      this.expandedPaths.set(new Set([result.path]));
      this.selectedPath.set(result.path);
      this.pathDraft.set(result.path);
      this.fileFilter.set('');
      if (!this.managerDirectory()) {
        this.managerDirectory.set(result);
        this.managerPathDraft.set(result.path);
        this.editorExplorer = this.createExplorerSnapshot(result);
      }
    } catch (error) {
      if (!this.destroyed && request === this.rootRequest) this.directoryError.set(this.directoryErrorMessage(error));
    } finally {
      if (!this.destroyed && request === this.rootRequest) this.directoryLoading.set(false);
    }
  }

  openExplorerPath(): void {
    if (this.activeView() === 'files') this.navigateFiles(this.pathDraft());
    else void this.loadDirectory(this.pathDraft());
  }

  onTreeClick(event: MouseEvent, row: ExplorerRow): void {
    const clickedChevron = event.target instanceof Element && !!event.target.closest('.explorer-chevron');
    if (this.activeView() === 'files' && !clickedChevron) {
      this.selectedPath.set(row.path);
      if (row.kind === 'directory' || row.kind === 'link') this.navigateFiles(row.path);
      else if (row.kind === 'file') void this.openTextFile(row.path);
      return;
    }
    this.toggleDirectory(row);
  }

  toggleDirectory(row: ExplorerRow): void {
    this.selectedPath.set(row.path);
    if (row.kind !== 'directory' && row.kind !== 'link') return;
    const expanded = new Set(this.expandedPaths());
    if (expanded.has(row.path)) expanded.delete(row.path);
    else expanded.add(row.path);
    this.expandedPaths.set(expanded);
    if (expanded.has(row.path) && !this.directoryStates()[row.path]?.data) void this.loadBranch(row.path);
  }

  async loadBranch(path: string): Promise<void> {
    if (this.status() !== 'connected' || this.directoryStates()[path]?.loading) return;
    const version = this.treeVersion;
    const pending: DirectoryState = { ...this.directoryStates()[path], loading: true, error: null };
    this.directoryStates.update((states) => ({ ...states, [path]: pending }));
    const isCurrent = () => !this.destroyed && version === this.treeVersion && this.directoryStates()[path] === pending;
    try {
      const api = window.electronAPI;
      if (!api) throw new Error('El explorador remoto solo está disponible en la aplicación de escritorio.');
      const result = await api.sftp.listDirectory(this.sessionId, path);
      if (!isCurrent()) return;
      let parent = path;
      while (parent !== this.directory()?.path && parent !== '/') {
        parent = parent.slice(0, parent.lastIndexOf('/')) || '/';
        if (this.directoryStates()[parent]?.data?.path === result.path) {
          throw new Error('Este enlace vuelve a una carpeta antecesora. No se despliega para evitar un ciclo.');
        }
      }
      const next = { ...this.directoryStates(), [path]: { data: result, loading: false, error: null } };
      const kinds = new Map(result.entries.map((entry) => [entry.name, entry.kind]));
      const removed = (pending.data?.entries ?? []).filter((entry) => kinds.get(entry.name) !== entry.kind)
        .map((entry) => `${path.replace(/\/$/, '')}/${entry.name}`);
      for (const key of Object.keys(next)) {
        if (removed.some((prefix) => key === prefix || key.startsWith(prefix + '/'))) delete next[key];
      }
      this.directoryStates.set(next);
      this.expandedPaths.update((paths) => new Set([...paths].filter((key) =>
        !removed.some((prefix) => key === prefix || key.startsWith(prefix + '/')))));
      const selected = this.selectedPath();
      if (selected && removed.some((prefix) => selected === prefix || selected.startsWith(prefix + '/'))) this.selectedPath.set(path);
    } catch (error) {
      if (isCurrent()) this.directoryStates.update((states) => ({
        ...states, [path]: { ...pending, loading: false, error: this.directoryErrorMessage(error) },
      }));
    }
  }

  private syncEditorExplorer(directory: RemoteDirectory): void {
    this.editorExplorer = this.createExplorerSnapshot(directory);
    if (this.activeView() === 'files') this.restoreExplorer('files');
  }

  async refreshTree(): Promise<void> {
    const root = this.directory()?.path;
    if (!root || this.treeRefreshing() || this.directoryLoading()) return;
    const version = this.treeVersion;
    const paths = [root, ...[...this.expandedPaths()].filter((path) => path !== root).sort((a, b) => a.length - b.length)];
    this.treeRefreshing.set(true);
    try {
      for (const path of paths) {
        if (this.destroyed || version !== this.treeVersion) break;
        if (path === root || (this.expandedPaths().has(path) && this.directoryStates()[path])) await this.loadBranch(path);
      }
    } finally {
      if (!this.destroyed) this.treeRefreshing.set(false);
    }
  }

  collapseTree(): void {
    const root = this.directory()?.path;
    this.expandedPaths.set(new Set(root ? [root] : []));
    this.selectedPath.set(root ?? null);
  }

  onTreeKeydown(event: KeyboardEvent, row: ExplorerRow): void {
    const rows = this.visibleTree();
    const index = rows.findIndex((item) => item.path === row.path);
    let target: string | undefined;
    switch (event.key) {
      case 'ArrowDown': target = rows[index + 1]?.path; break;
      case 'ArrowUp': target = rows[index - 1]?.path; break;
      case 'Home': target = rows[0]?.path; break;
      case 'End': target = rows.at(-1)?.path; break;
      case 'ArrowRight':
        if (row.kind === 'directory' || row.kind === 'link') {
          if (!row.expanded) this.toggleDirectory(row);
          else if (rows[index + 1]?.parent === row.path) target = rows[index + 1].path;
        }
        break;
      case 'ArrowLeft':
        if (row.expanded) this.toggleDirectory(row);
        else target = row.parent ?? undefined;
        break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (target) {
      this.selectedPath.set(target);
      const buttons = this.treeElement()?.nativeElement.querySelectorAll<HTMLButtonElement>('[role="treeitem"]');
      const button = Array.from(buttons ?? []).find((item) => item.dataset['path'] === target);
      button?.focus();
      button?.scrollIntoView({ block: 'nearest' });
    }
  }

  openManagerEntry(entry: RemoteDirectory['entries'][number]): void {
    const path = this.managerDirectory()?.path;
    if (!path) return;
    const entryPath = `${path.replace(/\/$/, '')}/${entry.name}`;
    if (entry.kind === 'directory' || entry.kind === 'link') this.navigateFiles(entryPath);
    else if (entry.kind === 'file') void this.openTextFile(entryPath);
  }

  async loadManagerDirectory(path: string, rememberForFiles = false): Promise<void> {
    if (this.status() !== 'connected') return;
    const request = ++this.managerRequest;
    this.directoryLoading.set(true); this.directoryError.set(null);
    try {
      const api = window.electronAPI; if (!api) throw new Error('El explorador remoto solo está disponible en la aplicación de escritorio.');
      const requestedPathInput = path.trim();
      if (!requestedPathInput) return;
      const current = this.managerDirectory()?.path;
      const requestedPath = current && !requestedPathInput.startsWith('/')
        ? `${current.replace(/\/$/, '')}/${requestedPathInput}`
        : requestedPathInput;
      const result = await api.sftp.listDirectory(this.sessionId, requestedPath);
      if (this.destroyed || request !== this.managerRequest) return;
      this.managerDirectory.set(result); this.managerPathDraft.set(result.path);
      if (rememberForFiles) this.rememberFileDirectory(result.path);
      this.syncEditorExplorer(result);
    } catch (error) {
      if (!this.destroyed && request === this.managerRequest) this.directoryError.set(this.directoryErrorMessage(error));
    } finally {
      if (!this.destroyed && request === this.managerRequest) this.directoryLoading.set(false);
    }
  }

  openCreate(kind: 'folder' | 'file'): void {
    this.createKind.set(kind); this.newItemName.set(''); this.fileActionError.set(null);
  }

  async createItem(): Promise<void> {
    const kind = this.createKind(); const parentPath = this.managerDirectory()?.path; const name = this.newItemName();
    if (!kind || !parentPath) return;
    this.fileActionLoading.set(true); this.fileActionError.set(null);
    try {
      const api = window.electronAPI; if (!api) throw new Error('Esta operación solo está disponible en la aplicación de escritorio.');
      if (kind === 'folder') await api.sftp.createDirectory(this.sessionId, parentPath, name);
      else await api.sftp.createTextFile(this.sessionId, parentPath, name);
      this.createKind.set(null); await this.loadManagerDirectory(parentPath);
    } catch (error) { this.fileActionError.set(this.directoryErrorMessage(error)); }
    finally { this.fileActionLoading.set(false); }
  }

  async openTextFile(path: string): Promise<void> {
    if (this.editorTabs().some((tab) => tab.path === path)) { this.activateEditor(path); return; }
    this.editorLoading.set(true); this.editorError.set(null);
    try {
      const api = window.electronAPI; if (!api) throw new Error('Esta operación solo está disponible en la aplicación de escritorio.');
      const file = await api.sftp.readTextFile(this.sessionId, path);
      if (this.editorTabs().some((tab) => tab.path === file.path)) this.activeEditorPath.set(file.path);
      else this.editorTabs.update((tabs) => [...tabs, { path: file.path, original: file.content, content: file.content }]);
      this.activeEditorPath.set(file.path);
    } catch (error) { this.editorError.set(this.directoryErrorMessage(error)); }
    finally { this.editorLoading.set(false); }
  }

  updateEditor(content: string): void {
    const path = this.activeEditorPath();
    if (path) this.editorTabs.update((tabs) => tabs.map((tab) => tab.path === path ? { ...tab, content } : tab));
  }

  async saveEditor(): Promise<void> {
    const editor = this.editor(); if (!editor || !this.editorDirty()) return;
    this.editorSaving.set(true); this.editorError.set(null);
    try {
      const api = window.electronAPI; if (!api) throw new Error('Esta operación solo está disponible en la aplicación de escritorio.');
      await api.sftp.writeTextFile(this.sessionId, editor.path, editor.content);
      this.editorTabs.update((tabs) => tabs.map((tab) => tab.path === editor.path ? { ...tab, original: editor.content } : tab));
    } catch (error) { this.editorError.set(this.directoryErrorMessage(error)); }
    finally { this.editorSaving.set(false); }
  }

  activateEditor(path: string): void {
    this.activeEditorPath.set(path); this.editorError.set(null);
  }

  closeEditor(path: string): void {
    const editor = this.editorTabs().find((tab) => tab.path === path);
    if (editor && editor.content !== editor.original && !window.confirm('Hay cambios sin guardar. ¿Quieres cerrar esta pestaña?')) return;
    const tabs = this.editorTabs(); const index = tabs.findIndex((tab) => tab.path === path);
    this.editorTabs.set(tabs.filter((tab) => tab.path !== path));
    if (this.activeEditorPath() === path) this.activeEditorPath.set(tabs[index + 1]?.path ?? tabs[index - 1]?.path ?? null);
    this.editorError.set(null);
  }

  navigateFiles(path: string): void {
    void this.loadManagerDirectory(path, true);
  }

  goBack(): void {
    this.goToHistory(this.fileHistoryIndex() - 1);
  }

  goForward(): void {
    this.goToHistory(this.fileHistoryIndex() + 1);
  }

  goUp(): void {
    const path = this.managerDirectory()?.path;
    if (path && path !== '/') this.navigateFiles(path.slice(0, path.lastIndexOf('/')) || '/');
  }

  private goToHistory(index: number): void {
    const path = this.fileHistory()[index];
    if (!path) return;
    void this.loadManagerDirectory(path).then(() => {
      if (this.managerDirectory()?.path === path) this.fileHistoryIndex.set(index);
    });
  }

  private saveExplorer(view: 'terminal' | 'files'): void {
    const snapshot: ExplorerSnapshot = {
      directory: this.directory(), states: this.directoryStates(), expanded: this.expandedPaths(),
      selected: this.selectedPath(), pathDraft: this.pathDraft(), filter: this.fileFilter(),
    };
    if (view === 'terminal') this.terminalExplorer = snapshot;
    else this.editorExplorer = snapshot;
  }

  private restoreExplorer(view: 'terminal' | 'files'): void {
    const snapshot = view === 'terminal' ? this.terminalExplorer : this.editorExplorer;
    if (!snapshot) return;
    this.treeVersion++;
    this.directory.set(snapshot.directory);
    this.directoryStates.set(snapshot.states);
    this.expandedPaths.set(new Set(snapshot.expanded));
    this.selectedPath.set(snapshot.selected);
    this.pathDraft.set(snapshot.pathDraft);
    this.fileFilter.set(snapshot.filter);
  }

  private createExplorerSnapshot(directory: RemoteDirectory): ExplorerSnapshot {
    return {
      directory,
      states: { [directory.path]: { data: directory, loading: false, error: null } },
      expanded: new Set([directory.path]),
      selected: directory.path,
      pathDraft: directory.path,
      filter: '',
    };
  }

  private rememberFileDirectory(path: string): void {
    const history = this.fileHistory();
    const index = this.fileHistoryIndex();
    if (history[index] === path) return;
    const next = [...history.slice(0, index + 1), path];
    this.fileHistory.set(next);
    this.fileHistoryIndex.set(next.length - 1);
  }

  private directoryErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'No se pudo abrir la carpeta remota.';
  }

  private onTerminalDirectoryReport(data: string): boolean {
    if (this.activeView() !== 'terminal' || this.status() !== 'connected') return true;
    const path = this.parseTerminalDirectoryReport(data);
    if (!path || path === this.directory()?.path) return true;
    void this.loadDirectory(path);
    return true;
  }

  private parseTerminalDirectoryReport(data: string): string | null {
    try {
      const report = new URL(data);
      if (report.protocol !== 'file:' || report.username || report.password || report.search || report.hash) return null;
      const path = decodeURIComponent(report.pathname);
      return path.startsWith('/') && !path.includes('\0') && path.length <= 4096 ? path : null;
    } catch {
      return null;
    }
  }

  // Render por GPU (WebGL): mucho más rápido con salidas grandes. Si no hay GPU, xterm usa el DOM.
  private loadGpuRenderer(): void {
    try {
      const webgl = new WebglAddon();
      // Windows puede quitar la GPU a una ventana en segundo plano. Se vuelve al render DOM
      // y se repinta; sin el repintado la terminal parece congelada y no muestra lo que escribes.
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (!this.destroyed) this.terminal.refresh(0, this.terminal.rows - 1);
      });
      this.terminal.loadAddon(webgl);
    } catch {
      // Sin WebGL disponible: se mantiene el render DOM por defecto.
    }
  }

  // Agrupa varios avisos de cambio de tamaño en un solo ajuste por fotograma.
  private scheduleFit(): void {
    if (this.fitScheduled) return;
    this.fitScheduled = true;
    requestAnimationFrame(() => {
      this.fitScheduled = false;
      if (!this.destroyed) this.fitAddon.fit();
    });
  }

  // --- Portapapeles ---
  async copySelection(text: string): Promise<void> {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
  }

  async pasteFromClipboard(): Promise<void> {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { text = ''; }
    if (text) this.terminal.paste(text);
  }

  copyFromContextMenu(): void {
    const selection = this.terminal.getSelection();
    if (selection) void this.copySelection(selection);
    this.contextMenu.set(null);
  }

  pasteFromContextMenu(): void {
    void this.pasteFromClipboard();
    this.contextMenu.set(null);
  }

  hasSelection(): boolean {
    return !!this.terminal.getSelection();
  }

  // --- Búsqueda ---
  openSearch(): void {
    this.setView('terminal');
    this.searchOpen.set(true);
    setTimeout(() => {
      this.searchInput()?.nativeElement.focus();
      this.searchInput()?.nativeElement.select();
    }, 0);
  }

  closeSearch(): void {
    this.searchOpen.set(false);
    this.searchQuery.set('');
    this.searchResult.set(null);
    this.searchAddon.clearDecorations();
    this.terminal.focus();
  }

  onSearchInput(): void {
    const query = this.searchQuery();
    if (!query) {
      this.searchAddon.clearDecorations();
      this.searchResult.set(null);
      return;
    }
    this.findNext(true);
  }

  findNext(incremental: boolean = false): void {
    const query = this.searchQuery();
    if (!query) return;
    this.searchAddon.findNext(query, this.buildSearchOptions(incremental));
  }

  findPrevious(): void {
    const query = this.searchQuery();
    if (!query) return;
    this.searchAddon.findPrevious(query, this.buildSearchOptions(false));
  }

  private buildSearchOptions(incremental: boolean): ISearchOptions {
    return {
      caseSensitive: this.searchCaseSensitive(),
      wholeWord: this.searchWholeWord(),
      regex: this.searchRegex(),
      incremental,
      decorations: {
        matchBackground: '#3b4350',
        matchBorder: '#596575',
        matchOverviewRuler: '#596575',
        activeMatchBackground: '#36536b',
        activeMatchBorder: '#91b9d9',
        activeMatchColorOverviewRuler: '#91b9d9',
      },
    };
  }

  private async connect(): Promise<void> {
    try {
      this.status.set('connecting');
      const result = await window.electronAPI?.ssh.connect(this.sessionId, this.terminal.cols, this.terminal.rows);
      if (result?.status === 'unknown-host') return;
      this.status.set('connected');
      void this.loadDirectory('.');
    } catch {
      this.status.set('error');
      this.errorMessage.set('No fue posible abrir la conexión SSH.');
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.directoryReportHandler?.dispose();
    this.stopListeningData?.();
    this.stopListeningUnknownHost?.();
    this.terminal.dispose();
  }
}
