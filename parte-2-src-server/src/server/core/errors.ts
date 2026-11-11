export { ForbiddenError, NotFoundError } from "../authz/authorize.ts";

/** Errore "di business" con un messaggio pronto per l'utente (campo opzionale per i form). */
export class ValidationError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}
