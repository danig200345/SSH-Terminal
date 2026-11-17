import { Injectable, signal } from '@angular/core';

export type SessionTab = { id: string; label: string };

const storageKey = 'ssh-client.session-tabs';

@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly tabList = signal<readonly SessionTab[]>(this.restoreTabs());
  readonly tabs = this.tabList.asReadonly();
  readonly activeId = signal<string | null>(this.restoreActiveId());

  open(id: string, label: string): void {
    if (!this.tabList().some((tab) => tab.id === id)) {
      this.tabList.update((tabs) => [...tabs, { id, label }]);
    }
    this.activeId.set(id);
    this.persist();
  }

  activate(id: string): void {
    this.activeId.set(id);
    this.persist();
  }

  close(id: string): void {
    this.tabList.update((tabs) => tabs.filter((tab) => tab.id !== id));
    if (this.activeId() === id) this.activeId.set(this.tabList().at(-1)?.id ?? null);
    this.persist();
  }

  private restoreTabs(): SessionTab[] {
    try {
      const value = sessionStorage.getItem(storageKey);
      return value ? JSON.parse(value) as SessionTab[] : [];
    } catch {
      return [];
    }
  }

  private restoreActiveId(): string | null {
    try {
      return sessionStorage.getItem(`${storageKey}.active`);
    } catch {
      return null;
    }
  }

  private persist(): void {
    sessionStorage.setItem(storageKey, JSON.stringify(this.tabList()));
    const activeId = this.activeId();
    if (activeId) sessionStorage.setItem(`${storageKey}.active`, activeId);
    else sessionStorage.removeItem(`${storageKey}.active`);
  }
}
