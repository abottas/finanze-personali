// Colori, icone e banche predefinite per personalizzare conti, fondi e categorie.
// I "loghi" sono tessere con i colori tipici della banca (nessun marchio incorporato, nessuna rete):
// per il logo vero si può caricare un'immagine dalla galleria (salvata cifrata nell'archivio).
export const COLORS = {
  indigo: '#5b6cf0', blue: '#0a84ff', teal: '#14b8a6', green: '#22b573', yellow: '#f5c400', amber: '#f59e0b',
  orange: '#fb7a3c', red: '#ef4455', pink: '#ec4899', purple: '#a35cf0', gray: '#8b93a7', ink: '#1b1e26', navy: '#0b3d91',
};
export const COLOR_KEYS = Object.keys(COLORS);
export const EMOJIS = ['💰', '🧾', '✈️', '🏖️', '🎄', '🏠', '🚗', '💻', '📱', '🎓', '🛡️', '🎁', '👕', '🎾', '🏋️', '🍽️', '🛒', '🩺', '🐶', '👶', '💍', '🛠️', '📈', '🏦', '💳', '📺', '🎵', '⭐', '🌱', '🔥'];
export const BANKS = {
  revolut: { name: 'Revolut', color: 'ink', mono: 'R', type: 'checking' },
  trade_republic: { name: 'Trade Republic', color: 'ink', mono: 'TR', type: 'savings' },
  isybank: { name: 'Isybank', color: 'green', mono: 'is', type: 'checking' },
  bbva: { name: 'BBVA', color: 'navy', mono: 'B', type: 'savings' },
  buddybank: { name: 'Buddybank', color: 'yellow', mono: 'bb', type: 'checking' },
  intesa: { name: 'Intesa Sanpaolo', color: 'green', mono: 'IS', type: 'checking' },
  unicredit: { name: 'UniCredit', color: 'red', mono: 'U', type: 'checking' },
  poste: { name: 'Poste / BancoPosta', color: 'blue', mono: 'P', type: 'checking' },
  fineco: { name: 'Fineco', color: 'blue', mono: 'F', type: 'checking' },
  n26: { name: 'N26', color: 'teal', mono: 'N', type: 'checking' },
  paypal: { name: 'PayPal', color: 'navy', mono: 'PP', type: 'other' },
  contanti: { name: 'Contanti', color: 'gray', mono: '€', type: 'cash' },
};
export const LOGO_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
export const MAX_LOGO_CHARS = 60000;
