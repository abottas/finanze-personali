// Errore applicativo con codice stabile (testabile) e messaggio in italiano per l'utente.
export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}
export const req = (cond, code, message) => {
  if (!cond) throw new AppError(code, message);
};
