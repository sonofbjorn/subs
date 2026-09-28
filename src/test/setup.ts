// Vitest runs in Node, which has no IndexedDB. `fake-indexeddb` provides a
// spec-compliant in-memory implementation so the Dexie repositories can be
// exercised for real instead of being mocked.
import 'fake-indexeddb/auto'
