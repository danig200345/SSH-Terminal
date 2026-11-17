import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { ConnectionService } from '../../services/connection';
import { SessionService } from '../../services/session';

@Component({
  selector: 'app-connections',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterOutlet],
  templateUrl: './connections.html',
  styleUrl: './connections.css',
})
export class Connections {
  readonly connectionService = inject(ConnectionService);
  readonly sessions = inject(SessionService);
  readonly sidebarOpen = signal(true);
  readonly query = signal('');
  private readonly router = inject(Router);

  readonly filteredConnections = computed(() => {
    const term = this.query().trim().toLocaleLowerCase();
    const connections = this.connectionService.connections();
    if (!term) return connections;

    return connections.filter((connection) =>
      [connection.name, connection.host, connection.username, String(connection.port)]
        .some((value) => value.toLocaleLowerCase().includes(term)),
    );
  });

  toggleSidebar(): void {
    this.sidebarOpen.update((isOpen) => !isOpen);
  }

  selectConnection(id: string): void {
    this.connectionService.selectConnection(id);
  }

  connect(id: string): void {
    const connection = this.connectionService.connections().find((item) => item.id === id);
    if (!connection) return;

    this.selectConnection(id);
    this.sessions.open(id, connection.name);
    void this.router.navigate(['/terminal', id]);
  }

  openTab(id: string): void {
    this.sessions.activate(id);
    void this.router.navigate(['/terminal', id]);
  }

  closeTab(id: string, event: MouseEvent): void {
    event.stopPropagation();
    void window.electronAPI?.ssh.disconnect(id);
    this.sessions.close(id);
  }

  edit(id: string, event: MouseEvent): void {
    event.stopPropagation();
    this.selectConnection(id);
    void this.router.navigate(['/connections/new'], { queryParams: { edit: id } });
  }
}
