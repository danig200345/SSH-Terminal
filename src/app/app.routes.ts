import { Routes } from '@angular/router';
import { ConnectionForm } from './pages/connection-form/connection-form';
import { Connections } from './pages/connections/connections';

export const routes: Routes = [
  {
    path: '',
    component: Connections,
    children: [{ path: 'connections/new', component: ConnectionForm }],
  },
  {
    path: 'terminal/:id',
    loadComponent: () =>
      import('./pages/terminal/terminal').then((module) => module.Terminal),
  },
  { path: '**', redirectTo: '' },
];
