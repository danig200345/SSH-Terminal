import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import type { ConnectionAuthenticationType } from '../../models/connection';
import { ConnectionService } from '../../services/connection';

@Component({
  selector: 'app-connection-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  templateUrl: './connection-form.html',
  styleUrl: './connection-form.css',
})
export class ConnectionForm {
  private readonly formBuilder = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly connections = inject(ConnectionService);

  readonly editingId = this.route.snapshot.queryParamMap.get('edit');

  readonly form = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
    host: ['', [Validators.required, Validators.maxLength(255)]],
    port: [22, [Validators.required, Validators.min(1), Validators.max(65535)]],
    username: ['', [Validators.required, Validators.maxLength(80)]],
    authenticationType: ['password' as ConnectionAuthenticationType],
    password: [''],
  });

  constructor() {
    const existing = this.connections.connections().find((connection) => connection.id === this.editingId);
    if (existing) this.form.patchValue(existing);
  }

  close(): void {
    void this.router.navigateByUrl('/');
  }

  async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const { password, ...draft } = this.form.getRawValue();
    if (!this.editingId && draft.authenticationType === 'password' && password.length === 0) {
      this.form.controls.password.setErrors({ required: true });
      return;
    }

    const connection = this.editingId
      ? await this.connections.updateConnection(this.editingId, draft)
      : await this.connections.addConnection(draft);
    if (draft.authenticationType === 'password' && password.length > 0) {
      await window.electronAPI?.credentials.savePassword(connection.id, password);
    }
    this.connections.selectConnection(connection.id);
    void this.router.navigateByUrl('/');
  }
}
