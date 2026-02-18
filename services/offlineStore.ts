
import { Ticket } from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PendingTicket {
  key: number;
  ticket: Ticket;
  attempts: number;
  lastAttempt: number;
  createdAt: number;
}

// ─── IndexedDB Offline Store ─────────────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 10;
const SYNC_INTERVAL_MS = 30_000; // 30 seconds
const API_BASE = '/api';

class OfflineStore {
  private dbName = 'lotus_it_portal';
  private storeName = 'pending_tickets';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;
  private available = true;

  /**
   * Open (or create) the IndexedDB database.
   * Silently marks the store as unavailable if IndexedDB is blocked
   * (e.g. Safari private mode, some enterprise policies).
   */
  async init(): Promise<void> {
    if (this.db) return;

    try {
      if (typeof indexedDB === 'undefined') {
        this.available = false;
        console.warn('[OfflineStore] IndexedDB is not available in this environment');
        return;
      }

      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.dbName, this.dbVersion);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { autoIncrement: true });
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      this.available = false;
      console.warn('[OfflineStore] IndexedDB unavailable — offline queueing disabled:', error);
    }
  }

  /** Whether the store initialised successfully. */
  isAvailable(): boolean {
    return this.available && this.db !== null;
  }

  /**
   * Queue a ticket for later sync.
   */
  async queueTicket(ticket: Ticket): Promise<void> {
    if (!this.isAvailable()) return;

    try {
      const entry = {
        ticket,
        attempts: 0,
        lastAttempt: 0,
        createdAt: Date.now(),
      };

      await this.txWrite((store) => {
        store.add(entry);
      });
    } catch (error) {
      console.error('[OfflineStore] Failed to queue ticket:', error);
    }
  }

  /**
   * Retrieve every pending ticket (including its IDB key).
   */
  async getPendingTickets(): Promise<PendingTicket[]> {
    if (!this.isAvailable()) return [];

    try {
      return await new Promise<PendingTicket[]>((resolve, reject) => {
        const tx = this.db!.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.openCursor();
        const results: PendingTicket[] = [];

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            results.push({
              key: cursor.key as number,
              ...cursor.value,
            });
            cursor.continue();
          } else {
            resolve(results);
          }
        };

        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('[OfflineStore] Failed to read pending tickets:', error);
      return [];
    }
  }

  /**
   * Remove a single ticket by its IDB key (after successful sync).
   */
  async removeTicket(key: number): Promise<void> {
    if (!this.isAvailable()) return;

    try {
      await this.txWrite((store) => {
        store.delete(key);
      });
    } catch (error) {
      console.error('[OfflineStore] Failed to remove ticket:', error);
    }
  }

  /**
   * Update a pending ticket's attempt metadata (after a failed sync attempt).
   */
  async updateTicket(key: number, updates: Partial<PendingTicket>): Promise<void> {
    if (!this.isAvailable()) return;

    try {
      // Read the current value, merge, and put it back under the same key.
      const current = await new Promise<any>((resolve, reject) => {
        const tx = this.db!.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      if (!current) return;

      const merged = {
        ...current,
        attempts: updates.attempts ?? current.attempts,
        lastAttempt: updates.lastAttempt ?? current.lastAttempt,
      };

      await this.txWrite((store) => {
        store.put(merged, key);
      });
    } catch (error) {
      console.error('[OfflineStore] Failed to update ticket:', error);
    }
  }

  /**
   * Count of pending tickets.
   */
  async getPendingCount(): Promise<number> {
    if (!this.isAvailable()) return 0;

    try {
      return await new Promise<number>((resolve, reject) => {
        const tx = this.db!.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('[OfflineStore] Failed to count tickets:', error);
      return 0;
    }
  }

  /**
   * Clear all pending tickets (e.g. after a full successful sync or manual purge).
   */
  async clear(): Promise<void> {
    if (!this.isAvailable()) return;

    try {
      await this.txWrite((store) => {
        store.clear();
      });
    } catch (error) {
      console.error('[OfflineStore] Failed to clear store:', error);
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Run a read-write transaction, wrapping the caller's work in a promise.
   */
  private txWrite(work: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      work(store);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export const offlineStore = new OfflineStore();

// ─── Sync Manager ────────────────────────────────────────────────────────────

class SyncManager {
  private isSyncing = false;
  private listeners: ((count: number) => void)[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private monitoringStarted = false;

  /**
   * Attempt to sync all pending tickets to the backend.
   *
   * - Skips tickets with >= MAX_RETRY_ATTEMPTS (dead-letter).
   * - On success: removes the ticket from IndexedDB.
   * - On failure: increments `attempts` and records `lastAttempt`.
   * - Notifies listeners of the new pending count after each pass.
   */
  async syncPendingTickets(): Promise<{ synced: number; failed: number }> {
    if (this.isSyncing) return { synced: 0, failed: 0 };

    this.isSyncing = true;
    let synced = 0;
    let failed = 0;

    try {
      await offlineStore.init();
      const pending = await offlineStore.getPendingTickets();

      for (const entry of pending) {
        // Dead-letter: skip tickets that have exhausted retries
        if (entry.attempts >= MAX_RETRY_ATTEMPTS) {
          failed++;
          continue;
        }

        try {
          // Direct fetch — bypasses apiService.saveTicket to avoid circular
          // imports and prevents re-queueing on failure.
          const response = await fetch(`${API_BASE}/tickets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry.ticket),
          });

          if (response.ok) {
            // Success — remove from the offline queue
            await offlineStore.removeTicket(entry.key);
            synced++;
          } else {
            // Server returned an error — count as a failed attempt
            await offlineStore.updateTicket(entry.key, {
              attempts: entry.attempts + 1,
              lastAttempt: Date.now(),
            });
            failed++;
          }
        } catch {
          // Network-level failure — increment attempt count
          await offlineStore.updateTicket(entry.key, {
            attempts: entry.attempts + 1,
            lastAttempt: Date.now(),
          });
          failed++;
        }
      }
    } catch (error) {
      console.error('[SyncManager] Sync pass failed:', error);
    } finally {
      this.isSyncing = false;
    }

    // Notify listeners with updated count
    const newCount = await offlineStore.getPendingCount();
    this.notifyListeners(newCount);

    // If nothing is pending any more, stop the periodic timer
    if (newCount === 0 && this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    return { synced, failed };
  }

  /**
   * Register a listener that fires whenever the pending count changes.
   * Returns an unsubscribe function.
   */
  onCountChange(listener: (count: number) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Notify all listeners about a pending-count change.
   * Also exposed so that apiService can trigger a count bump after queueing.
   */
  notifyListeners(count: number): void {
    for (const fn of this.listeners) {
      try {
        fn(count);
      } catch {
        // Listener threw — swallow to protect other listeners
      }
    }
  }

  /**
   * Start listening for connectivity changes and schedule periodic retries.
   */
  startMonitoring(): void {
    if (this.monitoringStarted) return;
    this.monitoringStarted = true;

    // Sync immediately when the browser comes back online
    window.addEventListener('online', () => {
      this.syncPendingTickets();
    });

    // Periodic retry every 30 s when there are pending tickets
    this.startPeriodicSync();
  }

  /**
   * Ensure the periodic interval is running.
   * Called internally whenever a ticket is queued.
   */
  ensurePeriodicSync(): void {
    this.startPeriodicSync();
  }

  private startPeriodicSync(): void {
    if (this.intervalId !== null) return;

    this.intervalId = setInterval(async () => {
      const count = await offlineStore.getPendingCount();
      if (count > 0) {
        await this.syncPendingTickets();
      } else {
        // Nothing pending — stop polling until something is queued again
        if (this.intervalId !== null) {
          clearInterval(this.intervalId);
          this.intervalId = null;
        }
      }
    }, SYNC_INTERVAL_MS);
  }
}

export const syncManager = new SyncManager();
