export type ConnectionAuthenticationType = 'password' | 'privateKey';

/**
 * Datos no sensibles que identifican una conexión SSH.
 * Las contraseñas, passphrases y llaves privadas no pertenecen a este modelo.
 */
export interface ConnectionProfile {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly authenticationType: ConnectionAuthenticationType;
}

/** Datos necesarios antes de asignar un identificador a una conexión. */
export interface ConnectionDraft {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly authenticationType: ConnectionAuthenticationType;
}
